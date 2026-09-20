import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
async function sources(directory) {
  const found = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (
      ["node_modules", ".svelte-kit", ".wrangler", "target", "dist", "tests", "testing"].includes(
        entry.name,
      )
    )
      continue;
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.(ts|js|mjs|svelte)$/.test(path) && !path.endsWith(".test.ts")) found.push(path);
  }
  return found;
}
test("application boundaries exclude platform adapters, business plugins and dependency cycles", async () => {
  const files = (
    await Promise.all(
      ["src", "controller/src", "shared", "sdk", "scripts", "plugins", "packages", "services"].map(
        sources,
      ),
    )
  ).flat();
  const graph = new Map(),
    violations = [];
  for (const path of files) {
    const content = await readFile(join(root, path), "utf8");
    const code = path.endsWith(".svelte")
      ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
          .map((match) => match[1])
          .join("\n")
      : content;
    const ast = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      dependencies = [];
    const imports = [];
    function scan(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, scan);
    }
    scan(ast);
    for (const specifier of imports) {
      const target = specifier.startsWith(".")
        ? relative(root, resolve(root, dirname(path), specifier)).replaceAll("\\", "/")
        : specifier.startsWith("@chord-control/")
          ? `packages/${specifier.slice("@chord-control/".length)}`
          : specifier;
      const local = files.find((file) => file === target || file === `${target}.ts`);
      if (local) dependencies.push(local);
      const forbid = (condition, reason) => {
        if (condition) violations.push(`${path} -> ${target}: ${reason}`);
      };
      forbid(
        path.startsWith("shared/") && /^(src|controller|sdk|plugins|scripts)\//.test(target),
        "shared contracts cannot import applications",
      );
      forbid(
        path.startsWith("sdk/") && /^(src|controller|plugins|scripts)\//.test(target),
        "SDK cannot depend on consumers",
      );
      forbid(
        path.startsWith("controller/src/domain/") &&
          /^controller\/src\/(application|infrastructure|transport|runtime)\//.test(target),
        "domain cannot depend on execution adapters",
      );
      forbid(
        path.startsWith("controller/src/application/") &&
          (/@earendil-works\/chord/.test(target) ||
            /^controller\/src\/(infrastructure|runtime|transport)\//.test(target)),
        "application uses ports",
      );
      forbid(
        path.startsWith("controller/src/infrastructure/") &&
          /^controller\/src\/(application|transport|runtime)\//.test(target),
        "infrastructure cannot orchestrate the app",
      );
      forbid(
        path.startsWith("controller/src/transport/") &&
          /^controller\/src\/(application|runtime)\//.test(target),
        "transports use narrow handlers and ports",
      );
      forbid(
        path.startsWith("src/components/") &&
          /^src\/lib\/(controller|desktop|native)\.ts$/.test(target),
        "views receive desktop behavior from their session",
      );
      forbid(
        path.startsWith("scripts/") && /^(src|controller|plugins)\//.test(target),
        "publisher uses shared contracts",
      );
      forbid(
        /^(controller|src)\//.test(path) && target.startsWith("plugins/"),
        "host must not embed plugin business logic",
      );
      forbid(
        path.startsWith("plugins/") && /^(src|controller|scripts)\//.test(target),
        "plugins use SDK contracts",
      );
      forbid(
        path.startsWith("plugins/") &&
          target.startsWith("plugins/") &&
          path.split("/")[1] !== target.split("/")[1],
        "plugins depend on shared service contracts rather than sibling source",
      );
      forbid(
        path.startsWith("packages/ui/") &&
          /^(src|controller|sdk|shared|plugins|scripts|packages\/contracts)\//.test(target),
        "reusable UI receives data and callbacks",
      );
      forbid(
        path.startsWith("packages/ui/") &&
          /^(node:|@tauri-apps\/|@earendil-works\/chord|\$app\/|\$env\/)/.test(target),
        "reusable UI is independent of host and application framework",
      );
      forbid(
        path.startsWith("src/pages/") && /^(\$app\/|@tauri-apps\/)/.test(target),
        "desktop pages receive navigation and native behavior from their application",
      );
      forbid(
        path.startsWith("packages/kit/") && /^(src|controller|sdk|plugins|services)\//.test(target),
        "shared Kit configuration cannot depend on application implementations",
      );
      forbid(
        path.startsWith("services/telemetry/ui/") && target.startsWith("services/telemetry/src/"),
        "dashboard calls the service through its HTTP client",
      );
      forbid(
        path.startsWith("packages/contracts/") &&
          /^(src|controller|sdk|plugins|scripts|packages\/ui)\//.test(target),
        "service contracts contain no provider implementation",
      );
      forbid(
        /^(src|controller|sdk)\//.test(path) && target.startsWith("packages/contracts/"),
        "host SDK does not own plugin business contracts",
      );
    }
    graph.set(path, dependencies);
  }
  const visited = new Set();
  function visit(path, stack = []) {
    assert(!stack.includes(path), `Circular dependency: ${[...stack, path].join(" -> ")}`);
    if (visited.has(path)) return;
    for (const next of graph.get(path) ?? []) visit(next, [...stack, path]);
    visited.add(path);
  }
  for (const path of files) visit(path);
  assert.deepEqual(violations, []);
});
