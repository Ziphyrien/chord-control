import type { PluginManifest } from "./protocol.ts";

export interface DependencyGraph {
  order: string[];
  dependencies: Map<string, string[]>;
  dependents: Map<string, string[]>;
  blocked: Map<string, string>;
}
/** A deterministic graph of declared service ownership; no platform or runtime imports. */
export function dependencyGraph(manifests: readonly PluginManifest[]): DependencyGraph {
  const sorted = [...manifests].sort((a, b) => a.id.localeCompare(b.id));
  const names = new Map(sorted.map((item) => [item.id, item.name]));
  const providers = new Map<string, string[]>();
  const dependencies = new Map(sorted.map((item) => [item.id, [] as string[]]));
  const dependents = new Map(sorted.map((item) => [item.id, [] as string[]]));
  const blocked = new Map<string, string>();
  for (const item of sorted)
    for (const service of item.services?.provides ?? []) {
      const owners = providers.get(service) ?? [];
      owners.push(item.id);
      providers.set(service, owners);
    }
  for (const [service, owners] of providers)
    if (owners.length > 1)
      for (const id of owners)
        blocked.set(id, `服务 ${service} 有多个提供者: ${owners.join("、")}`);
  for (const item of sorted) {
    for (const service of item.services?.requires ?? []) {
      const owners = providers.get(service) ?? [];
      if (owners.length !== 1) {
        blocked.set(
          item.id,
          owners.length ? `服务 ${service} 的提供者冲突` : `缺少依赖服务: ${service}`,
        );
        // Retain all potential reverse edges for safe disable/removal even in invalid graphs.
      }
      for (const owner of owners) {
        dependencies.get(item.id)!.push(owner);
        dependents.get(owner)!.push(item.id);
      }
    }
  }
  for (const links of [dependencies, dependents])
    for (const [id, values] of links) links.set(id, [...new Set(values)].sort());
  const completed = new Set<string>(),
    stack: string[] = [],
    order: string[] = [];
  function visit(id: string): void {
    if (completed.has(id)) return;
    const cycle = stack.indexOf(id);
    if (cycle >= 0) {
      const loop = [...stack.slice(cycle), id];
      for (const member of loop)
        blocked.set(member, `循环依赖: ${loop.map((key) => names.get(key) ?? key).join(" → ")}`);
      return;
    }
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    stack.pop();
    completed.add(id);
    order.push(id);
    if (!blocked.has(id)) {
      const unavailable = (dependencies.get(id) ?? []).find((key) => blocked.has(key));
      if (unavailable) blocked.set(id, `依赖不可用: ${names.get(unavailable) ?? unavailable}`);
    }
  }
  for (const item of sorted) visit(item.id);
  // A cycle can be discovered after a sibling was visited. Propagate until stable.
  for (let pass = 0; pass < sorted.length; pass++) {
    let changed = false;
    for (const item of sorted)
      if (!blocked.has(item.id)) {
        const parent = dependencies.get(item.id)!.find((id) => blocked.has(id));
        if (parent) {
          blocked.set(item.id, `依赖不可用: ${names.get(parent) ?? parent}`);
          changed = true;
        }
      }
    if (!changed) break;
  }
  return { order, dependencies, dependents, blocked };
}
export function dependentClosure(graph: DependencyGraph, id: string): string[] {
  const visited = new Set<string>([id]);
  function visit(current: string): void {
    for (const next of graph.dependents.get(current) ?? [])
      if (!visited.has(next)) {
        visited.add(next);
        visit(next);
      }
  }
  visit(id);
  visited.delete(id);
  return [...visited].sort();
}
export function assertResolvable(manifests: readonly PluginManifest[]): void {
  const graph = dependencyGraph(manifests);
  if (graph.blocked.size)
    throw new Error([...graph.blocked].map(([id, reason]) => `${id}: ${reason}`).join("；"));
}
