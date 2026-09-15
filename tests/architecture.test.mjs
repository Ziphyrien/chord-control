import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
async function collect(directory) {
  const files = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (/\.(ts|mjs|svelte)$/.test(path)) files.push(path);
  }
  return files;
}

test("module boundaries keep views, plugin execution and publishing independent", async () => {
  const files = (
    await Promise.all(["src", "controller/src", "shared", "sdk", "scripts"].map(collect))
  ).flat();
  const graph = new Map();
  const violations = [];
  for (const path of files) {
    const text = await readFile(join(root, path), "utf8");
    const script = path.endsWith(".svelte")
      ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
          .map((match) => match[1])
          .join("\n")
      : text;
    const ast = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const dependencies = [];
    for (const node of ast.statements) {
      if (
        (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        continue;
      const specifier = node.moduleSpecifier.text;
      const target = specifier.startsWith(".")
        ? relative(root, resolve(root, dirname(path), specifier)).replaceAll("\\", "/")
        : specifier;
      const local = files.find((file) => file === target || file === `${target}.ts`);
      if (local) dependencies.push(local);
      if (
        path.startsWith("src/components/") &&
        !target.startsWith("svelte") &&
        !target.startsWith("src/components/") &&
        target !== "shared/protocol.ts"
      )
        violations.push(`${path} must receive adapters via callbacks: ${target}`);
      if (path.startsWith("scripts/") && target.startsWith("controller/"))
        violations.push(`${path} must use shared plugin format: ${target}`);
      if (path.startsWith("shared/") && /^(src|controller|sdk)\//.test(target))
        violations.push(`${path} depends on an application layer: ${target}`);
      if (
        path === "controller/src/ui-server.ts" &&
        /controller\/src\/(runtime|plugin-manager|application|index)\.ts$/.test(target)
      )
        violations.push(`${path} must use the PluginUi port: ${target}`);
      if (
        path === "controller/src/runtime.ts" &&
        /controller\/src\/(application|plugin-manager|ui-server|index)\.ts$/.test(target)
      )
        violations.push(`${path} depends on orchestration: ${target}`);
    }
    graph.set(path, dependencies);
  }
  const visited = new Set();
  function visit(path, ancestors = []) {
    assert(!ancestors.includes(path), `Circular dependency: ${[...ancestors, path].join(" -> ")}`);
    if (visited.has(path)) return;
    for (const dependency of graph.get(path) ?? []) visit(dependency, [...ancestors, path]);
    visited.add(path);
  }
  for (const path of files) visit(path);
  assert.deepEqual(violations, []);
});
