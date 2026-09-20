import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const kitBuilder = fileURLToPath(new URL("../packages/kit/build-plugin.mjs", import.meta.url));

const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A self-contained document can be served by any generation-scoped plugin UI transport. */
export async function buildPluginUi({ directory, bundleDir, scratch, control, sourcePath, title }) {
  if (control.uiProject) {
    if (control.ui || control.uiScript)
      throw new Error("UI project cannot be combined with ui or uiScript");
    const configFile = await sourcePath(directory, control.uiProject);
    // Kit evaluates build-time server modules, which must resolve workspace dependencies.
    const projectDirectory = dirname(configFile);
    const workspace = join(resolve(projectDirectory), ".svelte-kit");
    await mkdir(workspace, { recursive: true });
    const root = await mkdtemp(join(workspace, "plugin-ui-"));
    try {
      await execute(process.execPath, [kitBuilder, configFile], {
        cwd: projectDirectory,
        // Signed UI bytes must not inherit development output from a test runner.
        env: { ...process.env, NODE_ENV: "production", CHORD_PLUGIN_UI_BUILD_ROOT: root },
        maxBuffer: 10 * 1024 * 1024,
      }).catch((error) => {
        throw new Error(
          `Plugin UI build failed: ${directory}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
          { cause: error },
        );
      });
      const html = await readFile(join(root, "public", "index.html"), "utf8");
      if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*\bhref\s*=/i.test(html))
        throw new Error("Plugin UI must embed its scripts and styles");
      await writeFile(join(bundleDir, "ui.html"), html, { flag: "wx" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return;
  }
  // Compatibility for existing third-party ui/uiScript plugin packages.
  let html = control.ui
    ? await readFile(await sourcePath(directory, control.ui), "utf8")
    : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head><body><div id="app"></div><!--PLUGIN_SCRIPT--></body></html>`;
  if (control.uiScript) {
    if (html.split("<!--PLUGIN_SCRIPT-->").length !== 2)
      throw new Error("UI template must contain exactly one <!--PLUGIN_SCRIPT-->");
    const [{ build }, { compile }] = await Promise.all([
      import("esbuild"),
      import("svelte/compiler"),
    ]);
    const result = await build({
      entryPoints: [await sourcePath(directory, control.uiScript)],
      bundle: true,
      write: false,
      outdir: join(scratch, "ui"),
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "none",
      conditions: ["svelte", "browser"],
      plugins: [
        {
          name: "plugin-svelte",
          setup(builder) {
            builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
              const compiled = compile(await readFile(path, "utf8"), {
                filename: relative(directory, path).replaceAll("\\", "/"),
                generate: "client",
                css: "injected",
                discloseVersion: false,
                cssHash: ({ hash, css }) => `svelte-${hash(css)}`,
              });
              return {
                contents: compiled.js.code,
                loader: "js",
                resolveDir: dirname(path),
                warnings: compiled.warnings.map((warning) => ({ text: warning.message })),
              };
            });
          },
        },
      ],
    });
    const script = result.outputFiles.find((file) => file.path.endsWith(".js"));
    if (!script) throw new Error("Plugin UI compiler produced no JavaScript");
    const css = result.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join("\n");
    if (
      result.outputFiles.some((file) => !file.path.endsWith(".js") && !file.path.endsWith(".css"))
    )
      throw new Error("Plugin UI must embed its assets");
    html = html.replace(
      "<!--PLUGIN_SCRIPT-->",
      () =>
        `${css ? `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` : ""}<script>${script.text.replace(/<\/script/gi, "<\\/script")}</script>`,
    );
  }
  await writeFile(join(bundleDir, "ui.html"), html, { flag: "wx" });
}
