import {
  createRemoteServiceBinding,
  type RemoteServiceBinding,
  type RemoteServiceProvider,
  type RemoteServiceSource,
  type RemoteServices,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withContextValue } from "@earendil-works/chord/context";
import { PluginCaller } from "../../sdk/index.ts";

type Provider = { owner: string; provider: RemoteServiceProvider };
type Consumer = {
  id: string;
  binding: RemoteServiceBinding;
  provider?: RemoteServiceProvider;
  onError(error: Error): void;
};
/** Chord's native service boundary; service IDs and contracts belong to plugins. */
export class ServiceRouter {
  private readonly providers = new Map<string, Provider>();
  private readonly consumers = new Set<Consumer>();
  validate(owner: string, provider: RemoteServiceProvider, exports: readonly string[]): void {
    for (const id of exports) {
      if (id.startsWith("chord-control.") || id.startsWith("$chord."))
        throw new Error(`宿主服务不能导出: ${id}`);
      if (!provider.catalogue.some((entry) => entry.serviceId === id))
        throw new Error(`插件未提供声明的服务: ${id}`);
      const previous = this.providers.get(id);
      if (previous && previous.owner !== owner) throw new Error(`服务已有提供者: ${id}`);
    }
  }
  async register(
    owner: string,
    provider: RemoteServiceProvider,
    exports: readonly string[],
  ): Promise<void> {
    this.validate(owner, provider, exports);
    for (const [id, value] of this.providers) if (value.owner === owner) this.providers.delete(id);
    for (const id of exports) this.providers.set(id, { owner, provider });
    await this.refresh();
  }
  async remove(owner: string): Promise<void> {
    for (const [id, value] of this.providers) if (value.owner === owner) this.providers.delete(id);
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    await Promise.all(
      [...this.consumers].map(async (consumer) => {
        const provider = this.providers.get(consumer.id)?.provider;
        if (provider === consumer.provider) return;
        consumer.provider = provider;
        try {
          await consumer.binding.rebind(Boolean(provider), BACKGROUND_CONTEXT);
        } catch (error) {
          consumer.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
  }
  source(owner: string, imports: readonly string[]): RemoteServiceSource {
    const allowed = new Set(imports);
    return {
      acceptsUnavailableServices: true,
      catalogue: async () =>
        [...this.providers]
          .filter(([id]) => allowed.has(id))
          .flatMap(([id, entry]) =>
            entry.provider.catalogue.filter((item) => item.serviceId === id),
          ),
      open: (options): RemoteServices => {
        const bindings = new Map<string, Consumer>();
        for (const { id } of options.services) {
          if (!allowed.has(id)) throw new Error(`插件未声明依赖服务: ${id}`);
          const getProvider = () => {
            const entry = this.providers.get(id);
            if (!entry) throw new Error(`依赖服务未运行: ${id}`);
            return entry.provider;
          };
          const consumer: Consumer = {
            id,
            provider: this.providers.get(id)?.provider,
            onError: options.onError,
            binding: createRemoteServiceBinding({
              services: [{ id }],
              bound: this.providers.has(id),
              assertAccess: options.assertAccess,
              onError: options.onError,
              transport: {
                invoke: (call, context) =>
                  getProvider().invoke(call, withContextValue(PluginCaller, owner, context)),
                subscribe: async (serviceId, mode, listener) =>
                  getProvider().subscribe(serviceId, mode, listener),
              },
            }),
          };
          bindings.set(id, consumer);
          this.consumers.add(consumer);
        }
        const bindingFor = (id: string) => {
          const consumer = bindings.get(id);
          if (!consumer) throw new Error(`服务未声明: ${id}`);
          return consumer.binding;
        };
        return {
          use: (service) => bindingFor(service.id).use(service),
          observe: (service, handler) => bindingFor(service.id).observe(service, handler),
          ready: async (context) => {
            await Promise.all([...bindings.values()].map(({ binding }) => binding.ready(context)));
          },
          dispose: async (context) => {
            for (const consumer of bindings.values()) this.consumers.delete(consumer);
            await Promise.all(
              [...bindings.values()].map(({ binding }) => binding.dispose(context)),
            );
          },
        };
      },
    };
  }
}
