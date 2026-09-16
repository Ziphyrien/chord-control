import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isBuiltin } from "node:module";
import {
  createFacetHost,
  defineFacet,
  type FacetHost,
  type LoadedFacets,
} from "@earendil-works/chord";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createFacetBundleLoader } from "@earendil-works/chord/node";
import { ControlHost, PluginUi, Lifecycle } from "../../sdk/index.ts";
import type { Json, PluginManifest } from "../../shared/protocol.ts";
import { unpack } from "./artifacts.ts";
import { safePath } from "../../shared/plugin-format.ts";
import type { PluginLifecycle, PluginPage, PluginUi as PluginUiPort } from "./ports.ts";
import { ServiceRouter } from "./service-router.ts";
import type { NativeBridge } from "./native-bridge.ts";

type Running = { host: FacetHost; loaded: LoadedFacets; root: string; manifest: PluginManifest };
export class PluginRuntime implements PluginLifecycle, PluginUiPort {
  private readonly running = new Map<string, Running>();
  private readonly services = new ServiceRouter();
  constructor(
    private readonly staging: string,
    private readonly data: string,
    private readonly log: (id: string, message: string) => void,
    private readonly present: (id: string, visible: boolean) => Promise<void> = async () => {},
    private readonly native?: NativeBridge,
  ) {}
  has(id: string): boolean {
    return this.running.has(id);
  }
  async activate(manifest: PluginManifest, archive: Uint8Array): Promise<void> {
    const root = await unpack(this.staging, manifest, archive);
    const dataDir = join(this.data, manifest.id);
    await mkdir(dataDir, { recursive: true });
    let loaded: LoadedFacets | undefined;
    let candidate: FacetHost | undefined;
    const previous = this.running.get(manifest.id);
    try {
      loaded = await createFacetBundleLoader({
        manifestPath: join(root, "chord-facets.json"),
        entry: manifest.entry ?? "worker",
        resolveExternal(specifier) {
          if (isBuiltin(specifier)) return specifier;
          throw new Error(`插件依赖未打包: ${specifier}`);
        },
      }).load();
      const hostFacet = defineFacet({
        id: "chord-control.host",
        setup: (env) =>
          env.provide(ControlHost, {
            native: async (operation, input, context) => {
              if (!this.native) throw new Error("Windows 原生宿主未连接");
              return this.native.call(
                manifest.id,
                manifest.permissions ?? [],
                operation,
                input,
                context.abortSignal,
              );
            },
            async paths() {
              return { dataDir, bundleDir: root };
            },
            log: async (message) => {
              this.log(manifest.id, String(message).slice(0, 4000));
            },
            present: async (visible) => {
              await this.present(manifest.id, visible);
            },
          }),
      });
      const facets = [hostFacet, ...loaded.facets];
      const compatible =
        previous &&
        JSON.stringify(previous.manifest.services) === JSON.stringify(manifest.services) &&
        JSON.stringify(previous.manifest.hooks) === JSON.stringify(manifest.hooks) &&
        JSON.stringify(previous.loaded.facets.map((facet) => facet.id)) ===
          JSON.stringify(loaded.facets.map((facet) => facet.id));
      if (compatible) {
        this.services.validate(
          manifest.id,
          previous.host.services,
          manifest.services?.provides ?? [],
        );
        await previous.host.reload(facets);
        candidate = previous.host;
      } else {
        candidate = await createFacetHost({
          facets,
          serviceSources: [this.services.source(manifest.id, manifest.services?.requires ?? [])],
          onError: (error) => this.log(manifest.id, error.message),
        });
        this.services.validate(manifest.id, candidate.services, manifest.services?.provides ?? []);
      }
      if (
        manifest.hooks?.length &&
        !candidate.services.catalogue.some((entry) => entry.serviceId === Lifecycle.id)
      )
        throw new Error("插件声明了生命周期钩子但未提供 Lifecycle 服务");
      await this.services.register(
        manifest.id,
        candidate.services,
        manifest.services?.provides ?? [],
      );
      this.running.set(manifest.id, { host: candidate, loaded, root, manifest });
    } catch (error) {
      if (candidate && candidate !== previous?.host) await candidate.dispose().catch(() => {});
      await loaded?.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    if (previous) {
      if (previous.host !== candidate)
        await previous.host.dispose().catch((error) => this.log(manifest.id, String(error)));
      await previous.loaded.dispose().catch((error) => this.log(manifest.id, String(error)));
      await rm(previous.root, { recursive: true, force: true }).catch((error) =>
        this.log(manifest.id, String(error)),
      );
    }
  }
  async deactivate(id: string): Promise<void> {
    const current = this.running.get(id);
    if (!current) return;
    await current.host.dispose();
    this.running.delete(id);
    await this.services.remove(id);
    await this.present(id, false);
    await current.loaded.dispose();
    await rm(current.root, { recursive: true, force: true });
  }
  async ui(id: string): Promise<PluginPage> {
    const current = this.running.get(id);
    if (!current?.manifest.ui) throw new Error("插件未运行或没有界面");
    return {
      html: await readFile(safePath(current.root, current.manifest.ui), "utf8"),
      revision: current.manifest.artifactSha256,
    };
  }
  async before(id: string, action: string, input: Json): Promise<boolean> {
    const current = this.running.get(id);
    if (!current) throw new Error(`此操作需要的插件未运行: ${id}`);
    const context = withAbortSignal(AbortSignal.timeout(120000), BACKGROUND_CONTEXT);
    return awaitWithContext(
      current.host.services.use(Lifecycle).before(action, input, context),
      context,
    );
  }
  async call(id: string, method: string, input: Json): Promise<Json> {
    const current = this.running.get(id);
    if (!current) throw new Error("插件未运行");
    const context = withAbortSignal(AbortSignal.timeout(30000), BACKGROUND_CONTEXT);
    return awaitWithContext(
      current.host.services.use(PluginUi).call(method, input, context),
      context,
    );
  }
  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.running.keys()].map((id) => this.deactivate(id)),
    );
    for (const result of results)
      if (result.status === "rejected") this.log("controller", String(result.reason));
  }
}
