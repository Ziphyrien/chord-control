import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Worker CSP allows same-origin files, but forbids Kit's inline SPA bootstrap.
export async function externalizeBootstrap(directory) {
  const index = new URL("index.html", directory);
  const html = await readFile(index, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1 || !scripts[0][1].includes("document.currentScript")) {
    throw new Error("Expected one classic SvelteKit SPA bootstrap script");
  }
  const source = scripts[0][1];
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const name = `bootstrap.${hash}.js`;
  await writeFile(new URL(name, directory), source);
  await writeFile(index, html.replace(scripts[0][0], `<script src="/${name}"></script>`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await externalizeBootstrap(new URL("./dist/", import.meta.url));
}
