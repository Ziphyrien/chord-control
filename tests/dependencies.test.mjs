import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { dependencyGraph, dependentClosure, assertResolvable } from "../shared/dependencies.ts";
import { manifest } from "./helpers.mjs";
const release = (id, provides = [], requires = []) =>
  manifest(id, { services: { provides, requires } });
test("dependency graph is deterministic and transitive", () => {
  const data = [release("c", [], ["b"]), release("b", ["b"], ["a"]), release("a", ["a"])];
  const graph = dependencyGraph(data);
  assert.deepEqual(graph.order, ["a", "b", "c"]);
  assert.deepEqual(dependentClosure(graph, "a"), ["b", "c"]);
  assert.equal(graph.blocked.size, 0);
  assert.deepEqual(graph.order, dependencyGraph([...data].reverse()).order);
});
test("missing services, duplicate providers and cycles are diagnosed and block downstream", () => {
  for (const data of [
    [release("a", [], ["absent"])],
    [release("a", ["auth"]), release("b", ["auth"]), release("c", [], ["auth"])],
    [release("a", ["a"], ["b"]), release("b", ["b"], ["a"]), release("c", [], ["a"])],
  ]) {
    const graph = dependencyGraph(data);
    assert.equal(graph.blocked.size, data.length);
    assert.throws(() => assertResolvable(data));
  }
});
test("self dependencies and consumers of cycles never produce a runnable plan", () => {
  const graph = dependencyGraph([release("a", ["a"], ["a"]), release("independent")]);
  assert.match(graph.blocked.get("a"), /循环/);
  assert(!graph.blocked.has("independent"));
});
