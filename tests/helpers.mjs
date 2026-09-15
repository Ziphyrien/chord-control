import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { buildPlugin } from "../scripts/build-plugins.mjs";
import { signingBytes } from "../shared/signing.ts";

export const repo = resolve(import.meta.dirname, "..");
export const pluginId = "com.example.system-info";
export function signed(value, key) {
  return { ...value, signature: sign(null, signingBytes(value), key).toString("base64") };
}
export async function createHarness(options = {}) {
  process.env.CHORD_CONTROL_ALLOW_LOCAL_HTTP = "1";
  const directory = await mkdtemp(join(tmpdir(), "chord-control-test-"));
  const buildDir = join(repo, "build", "fixtures", randomUUID());
  await mkdir(buildDir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const routes = new Map();
  const requests = [];
  let offline = false;
  const server = createServer((req, res) => {
    requests.push({ path: req.url, etag: req.headers["if-none-match"] });
    if (offline) {
      res.writeHead(503).end();
      return;
    }
    const body = routes.get(req.url);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      etag,
      "content-type": req.url.endsWith(".zip") ? "application/zip" : "application/json",
    });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let child,
    snapshot,
    stderr = "",
    pending = new Map();
  let executable = process.execPath,
    args = [join(repo, "build/controller.cjs")];
  if (options.sea) {
    executable = join(directory, "plugin-controller.exe");
    await copyFile(options.sea, executable);
    args = ["--stdio"];
  }
  async function start() {
    const env = {
      ...process.env,
      CHORD_CONTROL_DATA_DIR: join(directory, "data"),
      CHORD_CONTROL_ALLOW_LOCAL_HTTP: "1",
      CHORD_CONTROL_TEST: "1",
    };
    delete env.CHORD_CONTROL_ALLOW_UNSIGNED;
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    if (options.sea) {
      delete env.Path;
      env.PATH = join(process.env.SystemRoot ?? "C:/Windows", "System32");
    }
    child = spawn(executable, args, {
      cwd: directory,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    stderr = "";
    snapshot = undefined;
    const lines = createInterface({ input: child.stdout });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Controller did not start: ${stderr}`)),
        10000,
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        if (!snapshot) reject(new Error(`Controller exited ${code}: ${stderr}`));
        clearTimeout(timer);
      });
      lines.on("line", (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          reject(new Error(`Invalid stdout protocol: ${line}`));
          return;
        }
        if (event.type === "snapshot") {
          snapshot = event.snapshot;
          clearTimeout(timer);
          resolveReady();
        }
        if (event.type === "response") {
          const entry = pending.get(event.id);
          if (!entry) return;
          pending.delete(event.id);
          clearTimeout(entry.timer);
          if (event.ok) entry.resolve(event.result);
          else entry.reject(new Error(event.message));
        }
      });
    });
    await ready;
  }
  async function command(value) {
    const id = randomUUID();
    const response = new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Command ${value.type} timed out: ${stderr}`));
      }, 20000);
      pending.set(id, { resolve: resolveResponse, reject, timer });
    });
    child.stdin.write(JSON.stringify({ ...value, id }) + "\n");
    return response;
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 7000);
    const [code] = await exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Controller did not exit cleanly (${code}): ${stderr}`);
  }
  async function publish(manifest) {
    const artifact = await readFile(
      join(buildDir, basename(new URL(manifest.artifactUrl).pathname)),
    );
    routes.set(new URL(manifest.artifactUrl).pathname, artifact);
    routes.set("/manifest.json", Buffer.from(JSON.stringify(manifest)));
  }
  async function buildExample() {
    const manifest = await buildPlugin({
      directory: join(repo, "plugins/system-info"),
      outdir: buildDir,
      baseUrl,
      privateKey,
    });
    await publish(manifest);
    return manifest;
  }
  async function buildFixture(version, { fail = false, id = "com.test.lifecycle" } = {}) {
    const source = join(buildDir, id);
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: id, version, type: "module", control: {} }),
    );
    await writeFile(
      join(source, "src/worker.ts"),
      `import {defineFacet} from "@earendil-works/chord";
import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {appendFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {ControlHost,PluginUi} from ${JSON.stringify(join(repo, "sdk/index.ts"))};
export default defineFacet({id:${JSON.stringify(id + ".worker")},setup(env){
 const host=env.use(ControlHost); let file="";
 env.onActivate(async()=>{ file=join((await host.paths(BACKGROUND_CONTEXT)).dataDir,"ticks");
 if(${fail}) throw new Error("candidate activation rejected");
 appendFileSync(file,"A"); const timer=setInterval(()=>appendFileSync(file,"."),30); env.own(()=>clearInterval(timer)); });
 env.provide(PluginUi,{async call(method,input){if(method==="version")return ${JSON.stringify(version)};if(method==="ticks")return readFileSync(file,"utf8");throw new Error("unknown method");}});
}});`,
    );
    const manifest = await buildPlugin({
      directory: source,
      outdir: buildDir,
      baseUrl,
      privateKey,
    });
    await publish(manifest);
    return manifest;
  }
  function catalog(manifests) {
    const value = signed({ format: 1, plugins: manifests }, privateKey);
    routes.set("/catalog.json", Buffer.from(JSON.stringify(value)));
    return value;
  }
  async function close() {
    try {
      await stop();
    } finally {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Test closed"));
      }
      pending.clear();
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
      await rm(buildDir, { recursive: true, force: true });
    }
  }
  return {
    start,
    stop,
    command,
    close,
    buildExample,
    buildFixture,
    publish,
    catalog,
    routes,
    requests,
    privateKey,
    publicPem,
    baseUrl,
    directory,
    buildDir,
    get snapshot() {
      return snapshot;
    },
    get stderr() {
      return stderr;
    },
    set offline(value) {
      offline = value;
    },
  };
}
