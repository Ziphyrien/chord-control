import {
  createRemoteServiceBinding,
  type RemoteServiceProvider,
  type RemoteServiceSource,
} from "@earendil-works/chord";
import { withContextValue } from "@earendil-works/chord/context";
import { PluginCaller } from "../../../sdk/index.ts";

interface Provider {
  owner: string;
  service: RemoteServiceProvider;
}
/** Dependencies remain fixed for a generation. Lifecycle restarts consumers when providers change. */
export class ServiceDirectory {
  private readonly providers = new Map<string, Provider>();
  publish(owner: string, service: RemoteServiceProvider, exports: readonly string[]): void {
    for (const id of exports) {
      if (id.startsWith("chord-control.") || id.startsWith("$chord."))
        throw new Error(`禁止导出宿主服务: ${id}`);
      if (!service.catalogue.some((entry) => entry.serviceId === id))
        throw new Error(`插件未提供声明的服务: ${id}`);
      if (this.providers.has(id)) throw new Error(`服务已有提供者: ${id}`);
    }
    for (const id of exports) this.providers.set(id, { owner, service });
  }
  remove(owner: string): void {
    for (const [id, entry] of this.providers) if (entry.owner === owner) this.providers.delete(id);
  }
  source(owner: string, imports: readonly string[]): RemoteServiceSource {
    const allowed = new Set(imports);
    const provider = (id: string): RemoteServiceProvider => {
      if (!allowed.has(id)) throw new Error(`插件未声明依赖服务: ${id}`);
      const found = this.providers.get(id);
      if (!found) throw new Error(`依赖服务未运行: ${id}`);
      return found.service;
    };
    return {
      acceptsUnavailableServices: false,
      catalogue: async () =>
        imports.flatMap((id) => provider(id).catalogue.filter((entry) => entry.serviceId === id)),
      open: (options) => {
        for (const requested of options.services) provider(requested.id);
        return createRemoteServiceBinding({
          services: options.services,
          bound: true,
          assertAccess: options.assertAccess,
          onError: options.onError,
          transport: {
            invoke: (call, context) =>
              provider(call.serviceId).invoke(call, withContextValue(PluginCaller, owner, context)),
            subscribe: async (id, mode, listener) => provider(id).subscribe(id, mode, listener),
          },
        });
      },
    };
  }
}
