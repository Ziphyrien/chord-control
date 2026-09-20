import { createServer } from "vite-plus";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

try {
  const cacheDir = await mkdtemp(join(tmpdir(), "telemetry-vite-"));
  // Vite's cacheDir does not isolate Kit's generated route modules.
  const generated = fileURLToPath(new URL("../.svelte-kit/", import.meta.url));
  await mkdir(generated, { recursive: true });
  const outDir = await mkdtemp(join(generated, "test-"));
  process.env.TELEMETRY_TEST_KIT_OUT_DIR = outDir;
  const server = await createServer({
    cacheDir,
    // Workspace UI imports otherwise discover Bits UI after navigation and trigger a reload.
    optimizeDeps: { include: ["bits-ui"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      // These tests use fixed sources; sibling Kit output must not trigger HMR.
      watch: { ignored: ["**/.svelte-kit/**"] },
    },
    logLevel: "error",
  });
  await server.listen();
  process.send({ origin: `http://127.0.0.1:${server.httpServer.address().port}` });
  async function stop() {
    await server.close();
    await Promise.all([cacheDir, outDir].map((path) => rm(path, { recursive: true, force: true })));
    process.exit(0);
  }
  process.once("message", stop);
  process.once("disconnect", stop);
} catch (error) {
  process.send({ error: error.stack ?? String(error) });
  process.exit(1);
}
