import { dependentClosure } from "../../../shared/dependencies.ts";
import { message } from "../../../shared/validation.ts";
import type { Configuration } from "../domain/configuration.ts";
import type {
  Archives,
  ConfigRepository,
  PluginRuntime,
  Enqueue,
  Activity,
} from "../domain/ports.ts";
import { installedGraph } from "../domain/reconciliation.ts";
import { verifyRelease } from "../domain/releases.ts";

interface Dependencies {
  repository: ConfigRepository;
  archives: Archives;
  runtime: PluginRuntime;
  gate: Enqueue;
  log: Activity;
  allowUnsigned: boolean;
}
/** Owns runtime/disk transitions, dependency order, and rollback. No network access. */
export class PluginLifecycle {
  readonly errors = new Map<string, string>();
  private readonly dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  private async stop(config: Configuration, ids: Set<string>): Promise<void> {
    const { runtime } = this.dependencies,
      failures: unknown[] = [];
    for (const id of installedGraph(config).order.reverse())
      if (ids.has(id) && runtime.has(id)) {
        try {
          await runtime.deactivate(id);
        } catch (error) {
          failures.push(error);
        }
      }
    if (failures.length)
      throw new AggregateError(failures, `插件清理失败: ${failures.map(message).join("；")}`);
  }
  private async start(
    config: Configuration,
    required: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const { runtime, archives, allowUnsigned, log } = this.dependencies,
      graph = installedGraph(config, true);
    for (const id of graph.order) {
      const plugin = config.plugins.find((item) => item.id === id)!;
      let reason = graph.blocked.get(id);
      const offline = graph.dependencies.get(id)!.find((dependency) => !runtime.has(dependency));
      if (!reason && offline) reason = `依赖未运行: ${offline}`;
      if (reason) {
        this.errors.delete(id);
        if (required.has(id)) throw new Error(`${id}: ${reason}`);
        continue;
      }
      if (runtime.revision(id) === plugin.installed!.artifactSha256) continue;
      try {
        verifyRelease(plugin.installed!, plugin.source.publicKey, allowUnsigned);
        await runtime.activate(plugin.installed!, await archives.read(plugin.installed!));
        this.errors.delete(id);
      } catch (error) {
        this.errors.set(id, message(error));
        log("插件启动失败", `${id}: ${message(error)}`, "error");
        if (required.has(id)) throw error;
      }
    }
  }
  restore(): Promise<void> {
    return this.dependencies.gate(() => this.start(this.dependencies.repository.snapshot()));
  }
  async commit(
    next: Configuration,
    required: readonly string[] = [],
    validate: () => void = () => {},
  ): Promise<void> {
    const { repository, runtime, gate, log } = this.dependencies;
    await gate(async () => {
      validate();
      const before = repository.snapshot(),
        graph = installedGraph(before),
        desired = new Map(next.plugins.map((item) => [item.id, item]));
      const stop = new Set<string>();
      for (const previous of before.plugins) {
        const wanted = desired.get(previous.id);
        if (
          !wanted?.enabled ||
          !wanted.installed ||
          wanted.installed.artifactSha256 !== previous.installed?.artifactSha256
        ) {
          stop.add(previous.id);
          for (const dependent of dependentClosure(graph, previous.id)) stop.add(dependent);
        }
      }
      const plan = installedGraph(next, true),
        mustStart = new Set(required);
      for (const id of stop)
        if (desired.get(id)?.enabled && desired.get(id)?.installed) mustStart.add(id);
      for (const id of mustStart)
        if (plan.blocked.has(id)) throw new Error(`${id}: ${plan.blocked.get(id)}`);
      try {
        await this.stop(before, stop);
        await this.start(next, mustStart);
        await repository.commit(next);
      } catch (error) {
        // A candidate may have acquired resources even when later persistence fails.
        const rollback = new Set(
          next.plugins
            .filter(
              (item) =>
                runtime.has(item.id) &&
                (!before.plugins.some(
                  (previous) =>
                    previous.id === item.id &&
                    previous.enabled &&
                    previous.installed?.artifactSha256 === item.installed?.artifactSha256,
                ) ||
                  stop.has(item.id)),
            )
            .map((item) => item.id),
        );
        try {
          await this.stop(next, rollback);
          await this.start(
            before,
            new Set(
              before.plugins
                .filter((item) => item.enabled && item.installed && stop.has(item.id))
                .map((item) => item.id),
            ),
          );
        } catch (recovery) {
          log("恢复插件失败", message(recovery), "error");
          throw new AggregateError(
            [error, recovery],
            `${message(error)}；恢复失败: ${message(recovery)}`,
          );
        }
        throw error;
      }
    });
  }
  shutdown(): Promise<void> {
    return this.dependencies.gate(async () => {
      const config = this.dependencies.repository.snapshot();
      await this.stop(config, new Set(config.plugins.map((item) => item.id)));
    });
  }
}
