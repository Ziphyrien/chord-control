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
import { ControlHost, Lifecycle, PluginUi } from "../../../sdk/index.ts";
import {
  HostDiagnostics,
  PluginDiagnostics,
  isDiagnosticSnapshot,
} from "../../../sdk/diagnostics.ts";
import type { Json, PluginManifest } from "../../../shared/protocol.ts";
import { safePath } from "../../../shared/plugin-format.ts";
import { jsonValue, message } from "../../../shared/validation.ts";
import type { PluginRuntime, PluginPage } from "../domain/ports.ts";
import { unpack } from "../infrastructure/archives.ts";
import type { NativeBridge } from "../transport/native-bridge.ts";
import { ServiceDirectory } from "./services.ts";
import { HostKernel } from "../../../sdk/kernel.ts";
import { KernelCaller, KernelSession } from "./kernel-session.ts";
import { OperationMetrics } from "../infrastructure/operation-metrics.ts";

interface Access {
  phase: "starting" | "active" | "stopping" | "closed";
}
interface Generation {
  manifest: PluginManifest;
  root: string;
  host: FacetHost;
  loaded: LoadedFacets;
  lifetime: AbortController;
  access: Access;
  kernel: KernelSession;
}
interface Options {
  staging: string;
  data: string;
  native: NativeBridge;
  log(id: string, detail: string): void;
  present(id: string, visible: boolean): Promise<void>;
  snapshot?(): Json;
  metrics?: OperationMetrics;
}
/** Chord is an adapter. Dependency and update policy belong to the application layer. */
export class ChordRuntime implements PluginRuntime {
  private readonly running = new Map<string, Generation>();
  private readonly retired = new Set<string>();
  private collecting = false;
  private readonly services = new ServiceDirectory();
  private readonly options: Options;
  private readonly metrics: OperationMetrics;
  constructor(options: Options) {
    this.options = options;
    this.metrics = options.metrics ?? new OperationMetrics();
  }
  has(id: string): boolean {
    return this.running.has(id);
  }
  revision(id: string): string | undefined {
    return this.running.get(id)?.manifest.artifactSha256;
  }
  private current(id: string): Generation {
    const current = this.running.get(id);
    if (!current) throw new Error(`插件未运行: ${id}`);
    return current;
  }
  activate(manifest: PluginManifest, archive: Uint8Array): Promise<void> {
    return this.metrics.measure(manifest.id, "activate", () =>
      this.activateGeneration(manifest, archive),
    );
  }
  private async activateGeneration(manifest: PluginManifest, archive: Uint8Array): Promise<void> {
    if (this.has(manifest.id)) throw new Error(`插件必须先停止: ${manifest.id}`);
    if (this.retired.has(manifest.id))
      throw new Error(`插件资源清理未完成，请重启控制器: ${manifest.id}`);
    const root = await unpack(this.options.staging, manifest, archive);
    const dataDir = join(this.options.data, manifest.id);
    let host: FacetHost | undefined, loaded: LoadedFacets | undefined;
    let visible: boolean | undefined;
    const access: Access = { phase: "starting" };
    const lifetime = new AbortController();
    const kernel = new KernelSession(this.options.native, manifest.id, manifest.permissions ?? []);
    try {
      await mkdir(dataDir, { recursive: true });
      loaded = await createFacetBundleLoader({
        manifestPath: join(root, "chord-facets.json"),
        entry: manifest.entry ?? "worker",
        resolveExternal: (specifier) => {
          if (isBuiltin(specifier)) return specifier;
          throw new Error(`插件依赖未打包: ${specifier}`);
        },
      }).load();
      const capabilities = defineFacet({
        id: "chord-control.host",
        setup: (env) => {
          env.provide(ControlHost, {
            paths: async () => ({ dataDir, bundleDir: root }),
            log: async (detail) => this.options.log(manifest.id, String(detail).slice(0, 4000)),
            native: (operation, input, context) => {
              if (access.phase === "closed") throw new Error("插件代已停止");
              return this.options.native.call(
                manifest.id,
                manifest.permissions ?? [],
                operation,
                input,
                context.abortSignal,
              );
            },
            present: async (next) => {
              if (typeof next !== "boolean") throw new Error("窗口可见状态无效");
              if (access.phase === "stopping" || access.phase === "closed") return;
              visible = next;
              if (access.phase === "active") await this.options.present(manifest.id, next);
            },
          });
          env.provide(HostDiagnostics, {
            snapshot: async (context) => {
              if (access.phase !== "active" || !manifest.permissions?.includes("diagnostics"))
                throw new Error("插件没有诊断读取权限或已停止");
              const controller = this.options.snapshot?.() ?? { error: "主程序诊断不可用" };
              let native: Json;
              try {
                native = await this.options.native.call(
                  manifest.id,
                  manifest.permissions,
                  "diagnostics.snapshot",
                  null,
                  context.abortSignal,
                );
              } catch (error) {
                native = { error: message(error) };
              }
              return {
                controller,
                native,
                metrics: this.metrics.snapshot(),
                plugins: await this.diagnostics(context.abortSignal),
              };
            },
          });
          env.provide(HostKernel, {
            call: (operation, input, context) => {
              if (access.phase === "stopping" || access.phase === "closed")
                throw new Error("插件 API 已停止");
              if (!manifest.permissions?.includes("host-control"))
                throw new Error("插件未声明 host-control 权限");
              return (context.value(KernelCaller) ?? kernel).call(operation, input, context);
            },
          });
        },
      });
      host = await createFacetHost({
        facets: [capabilities, ...loaded.facets],
        serviceSources: [
          this.services.source(manifest.id, manifest.services?.requires ?? [], kernel),
        ],
        onError: (error) => this.options.log(manifest.id, error.message),
      });
      if (
        manifest.hooks?.length &&
        !host.services.catalogue.some((item) => item.serviceId === Lifecycle.id)
      )
        throw new Error("插件声明了生命周期钩子但未提供 Lifecycle 服务");
      if (manifest.ui && !host.services.catalogue.some((item) => item.serviceId === PluginUi.id))
        throw new Error("插件声明了界面但未提供 PluginUi 服务");
      this.services.publish(manifest.id, host.services, manifest.services?.provides ?? []);
      this.running.set(manifest.id, { manifest, root, host, loaded, lifetime, access, kernel });
      access.phase = "active";
      if (visible !== undefined) await this.options.present(manifest.id, visible);
    } catch (error) {
      access.phase = "stopping";
      kernel.stop();
      lifetime.abort();
      this.running.delete(manifest.id);
      this.services.remove(manifest.id);
      const failures: unknown[] = [];
      for (const cleanup of [
        () => host?.dispose(),
        () => kernel.close(),
        () => loaded?.dispose(),
        () => rm(root, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup();
        } catch (failure) {
          failures.push(failure);
        }
      }
      access.phase = "closed";
      if (failures.length) {
        this.retired.add(manifest.id);
        throw new AggregateError(
          [error, ...failures],
          `${message(error)}；候选插件清理失败: ${failures.map(message).join("；")}`,
        );
      }
      throw error;
    }
  }
  deactivate(id: string): Promise<void> {
    return this.metrics.measure(id, "deactivate", () => this.deactivateGeneration(id));
  }
  private async deactivateGeneration(id: string): Promise<void> {
    const current = this.running.get(id);
    if (!current) return;
    current.access.phase = "stopping";
    current.kernel.stop();
    current.lifetime.abort(new Error("插件正在停止"));
    this.running.delete(id);
    this.services.remove(id);
    const failures: unknown[] = [];
    // Keep native replies available while plugin-owned cleanup restores resources.
    for (const cleanup of [
      () => current.host.dispose(),
      () => current.kernel.close(),
      () => this.options.present(id, false),
      () => current.loaded.dispose(),
      () => rm(current.root, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    current.access.phase = "closed";
    if (failures.length) {
      this.retired.add(id);
      throw new AggregateError(failures, `${id} 清理失败: ${failures.map(message).join("；")}`);
    }
  }
  private async diagnostics(signal?: AbortSignal): Promise<Json> {
    if (this.collecting) return { unavailable: { error: "已有插件诊断正在进行" } };
    this.collecting = true;
    try {
      return await this.collectDiagnostics(signal);
    } finally {
      this.collecting = false;
    }
  }
  private async collectDiagnostics(signal?: AbortSignal): Promise<Json> {
    const result: Record<string, Json> = {};
    const deadline = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    let bytes = 0;
    for (const [id, generation] of this.running) {
      if (
        !generation.host.services.catalogue.some((item) => item.serviceId === PluginDiagnostics.id)
      )
        continue;
      const context = withAbortSignal(
        AbortSignal.any([generation.lifetime.signal, AbortSignal.timeout(5000), deadline]),
        BACKGROUND_CONTEXT,
      );
      try {
        const value = await awaitWithContext(
          generation.host.services.use(PluginDiagnostics).snapshot(context),
          context,
        );
        if (!isDiagnosticSnapshot(value) || Buffer.byteLength(JSON.stringify(value)) > 16000)
          throw new Error("插件诊断超出限制");
        bytes += Buffer.byteLength(JSON.stringify(value));
        if (bytes > 48 * 1024) throw new Error("插件诊断总量超出限制");
        result[id] = value;
      } catch (error) {
        result[id] = { error: message(error).slice(0, 1000) };
      }
      if (deadline.aborted || bytes > 48 * 1024) break;
    }
    return result;
  }
  async ui(id: string): Promise<PluginPage> {
    const generation = this.current(id);
    if (!generation.manifest.ui) throw new Error("插件没有界面");
    return {
      html: await readFile(safePath(generation.root, generation.manifest.ui), "utf8"),
      revision: generation.manifest.artifactSha256,
    };
  }
  before(id: string, action: string, input: Json): Promise<boolean> {
    return this.metrics.measure(id, "authorize", () => this.authorize(id, action, input));
  }
  private async authorize(id: string, action: string, input: Json): Promise<boolean> {
    const generation = this.current(id);
    const context = withAbortSignal(
      AbortSignal.any([generation.lifetime.signal, AbortSignal.timeout(120_000)]),
      BACKGROUND_CONTEXT,
    );
    const result = await awaitWithContext(
      generation.host.services.use(Lifecycle).before(action, input, context),
      context,
    );
    return result === true;
  }
  call(id: string, method: string, input: Json): Promise<Json> {
    return this.metrics.measure(id, "rpc", () => this.invoke(id, method, input));
  }
  private async invoke(id: string, method: string, input: Json): Promise<Json> {
    const generation = this.current(id);
    const context = withAbortSignal(
      AbortSignal.any([generation.lifetime.signal, AbortSignal.timeout(30_000)]),
      BACKGROUND_CONTEXT,
    );
    const result = await awaitWithContext(
      generation.host.services.use(PluginUi).call(method, input, context),
      context,
    );
    if (!jsonValue(result)) throw new Error("插件返回了非 JSON 值");
    return result;
  }
}
