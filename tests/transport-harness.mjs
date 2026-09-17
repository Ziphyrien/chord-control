import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { zipSync } from "fflate";
import { publisher, signed } from "./helpers.mjs";

export const fixtureId = "com.test.fixture";
const context =
  'const context={abortSignal:undefined,value(){return undefined},toString(){return "fixture"}};';
/** A hand-written CommonJS fixture: packaging these bytes requires no TS, Vite, Rust or SEA build. */
function fixtureSource(version, options = {}) {
  return `${context}
exports.default={id:${JSON.stringify(options.id ?? fixtureId)},setup(env){
 const host=env.use({id:"chord-control.host",local:false});
 ${options.requireService ? 'const auth=env.use({id:"fixture.auth",local:false});' : ""}
 ${options.provideService ? 'env.provide({id:"fixture.auth",local:false},{authorize:async()=>true});' : ""}
 ${options.hooks ? 'env.provide({id:"chord-control.lifecycle",local:false},{before:async()=>' + (options.requireService ? "auth.authorize(context)" : "true") + "});" : ""}
 env.provide({id:"chord-control.ui",local:false},{call:async(method,input)=>{
 if(method==="version")return ${JSON.stringify(version)};
 if(method==="echo")return input;
 if(method==="paths")return host.paths(context);
 if(method==="native")return host.native("wallpaper.get",null,context);
 if(method==="authorize")return ${options.requireService ? "auth.authorize(context)" : "true"};
 return null;
 }});
 ${options.fail ? 'env.onActivate(()=>{throw new Error("fixture activation failed")});' : ""}
 ${options.cleanup ? 'env.own(()=>host.native("wallpaper.get",null,context));' : ""}
}};`;
}
export async function createTransportHarness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "chord-test-")),
    dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  // Explicit empty settings avoid touching the public catalogue during local tests.
  await writeFile(
    join(dataDir, "config.json"),
    JSON.stringify({
      format: 2,
      settings: {
        checkIntervalMinutes: 30,
        autoUpdate: true,
        catalogUrl: "",
        catalogPublicKey: "",
      },
      plugins: [],
      suppressed: [],
    }),
  );
  const keys = publisher(),
    routes = new Map(),
    requests = [],
    events = [],
    native = [];
  let child,
    snapshot,
    offline = false,
    stderr = "",
    closing;
  const pending = new Map(),
    waiters = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const value = routes.get(request.url);
    if (offline || !value) {
      response.writeHead(503).end();
      return;
    }
    const etag = `"${createHash("sha256").update(value).digest("hex")}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304).end();
      return;
    }
    response.setHeader("ETag", etag);
    response.end(value);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  function receive(event) {
    events.push(event);
    if (event.type === "snapshot") snapshot = event.snapshot;
    if (event.type === "response") {
      const waiter = pending.get(event.id);
      if (waiter) {
        pending.delete(event.id);
        clearTimeout(waiter.timer);
        if (event.ok) waiter.resolve(event.result);
        else waiter.reject(new Error(event.message));
      }
    }
    if (event.type === "native_request") {
      native.push(event);
      child.stdin.write(
        JSON.stringify({
          type: "native_response",
          id: event.id,
          ok: true,
          result: options.native?.(event) ?? {
            path: "C:\\Windows\\Web\\Wallpaper\\Windows\\img0.jpg",
            style: "10",
          },
        }) + "\n",
      );
    }
    // Snapshot listeners because resolution removes them from the live list.
    for (const waiter of waiters.slice())
      if (waiter.predicate(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
  }
  const h = {
    root,
    dataDir,
    baseUrl,
    routes,
    requests,
    events,
    native,
    publicKey: keys.publicKey,
    get pid() {
      return child?.pid;
    },
    get snapshot() {
      return snapshot;
    },
    get stderr() {
      return stderr;
    },
    set offline(value) {
      offline = value;
    },
    waitFor(predicate, timeout = 8000) {
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`event timeout\n${stderr}`));
          }, timeout),
        };
        waiters.push(waiter);
      });
    },
    async fixture(version = "1.0.0", extra = {}) {
      const id = extra.id ?? fixtureId,
        source = extra.source ?? fixtureSource(version, extra),
        hash = createHash("sha256").update(source).digest(),
        file = `worker-${hash.toString("hex")}.cjs`;
      const facet = {
        format: "chord.facet-bundle",
        formatVersion: 2,
        plugin: { id, version },
        entries: {
          worker: { file, integrity: `sha256-${hash.toString("base64")}`, externalImports: [] },
        },
      };
      const zip = Buffer.from(
        zipSync({
          "chord-facets.json": Buffer.from(JSON.stringify(facet)),
          [file]: Buffer.from(source),
          "ui/index.html": Buffer.from("<!doctype html><title>fixture</title><p>Fixture UI</p>"),
        }),
      );
      const artifactPath = `/${id}-${version}-${createHash("sha256").update(zip).digest("hex").slice(0, 8)}.zip`;
      const release = signed(
        {
          id,
          name: id,
          version,
          artifactUrl: baseUrl + artifactPath,
          artifactSha256: createHash("sha256").update(zip).digest("hex"),
          ui: "ui/index.html",
          permissions: extra.permissions ?? (extra.native || extra.cleanup ? ["wallpaper"] : []),
          ...(extra.provideService || extra.requireService
            ? {
                services: {
                  provides: extra.provideService ? ["fixture.auth"] : [],
                  requires: extra.requireService ? ["fixture.auth"] : [],
                },
              }
            : {}),
          ...(extra.services ? { services: extra.services } : {}),
          ...(extra.hooks ? { hooks: ["desktop.open"] } : {}),
        },
        keys.privateKey,
      );
      routes.set(artifactPath, zip);
      routes.set(`/${id}.json`, Buffer.from(JSON.stringify(release)));
      return release;
    },
    catalogue(releases) {
      const catalog = signed({ format: 1, plugins: releases }, keys.privateKey);
      routes.set("/catalog.json", Buffer.from(JSON.stringify(catalog)));
    },
    async start() {
      if (child) throw new Error("already started");
      snapshot = undefined;
      let executable = process.execPath,
        args = [resolve("controller/src/index.ts")];
      const env = {
        ...process.env,
        CHORD_CONTROL_DATA_DIR: dataDir,
        CHORD_CONTROL_ALLOW_UNSIGNED: "0",
        CHORD_CONTROL_ALLOW_LOCAL_HTTP: "1",
      };
      if (options.sea) {
        executable = join(root, "controller.exe");
        await copyFile(options.sea, executable);
        args = [];
        env.PATH = join(root, "empty-path");
      }
      const started = h.waitFor((event) => event.type === "snapshot", 15000);
      child = spawn(executable, args, {
        cwd: options.sea ? root : resolve("."),
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          receive(JSON.parse(line));
        } catch (error) {
          stderr += `\n${error.stack}\n${line}`;
        }
      });
      child.once("exit", (code) => {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`controller exited ${code}\n${stderr}`));
        }
        pending.clear();
      });
      await started;
    },
    command(command) {
      return new Promise((resolve, reject) => {
        const id = randomUUID(),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`command timeout ${command.type}\n${stderr}`));
          }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      });
    },
    async add(release) {
      return h.command({
        type: "add_plugin",
        manifestUrl: `${baseUrl}/${release.id}.json`,
        publicKey: keys.publicKey,
      });
    },
    async stop() {
      if (!child) return;
      if (closing) return closing;
      closing = new Promise((resolve, reject) => {
        const processToStop = child,
          timer = setTimeout(() => {
            processToStop.kill();
            reject(new Error(`shutdown timeout\n${stderr}`));
          }, 18000);
        processToStop.once("exit", (code) => {
          clearTimeout(timer);
          child = undefined;
          closing = undefined;
          if (code === 0) resolve();
          else reject(new Error(`shutdown failed ${code}\n${stderr}`));
        });
        processToStop.stdin.write(JSON.stringify({ id: randomUUID(), type: "shutdown" }) + "\n");
      });
      return closing;
    },
    async close() {
      try {
        await h.stop();
      } finally {
        for (const waiter of pending.values()) clearTimeout(waiter.timer);
        for (const waiter of waiters) clearTimeout(waiter.timer);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 75 });
      }
    },
    async seed(directory, ids) {
      const catalog = JSON.parse(await readFile(join(directory, "catalog.json"), "utf8"));
      const publicKey = await readFile(resolve("config/plugin-public.pem"), "utf8");
      const releases = catalog.plugins.filter((item) => ids.includes(item.id));
      if (releases.length !== ids.length)
        throw new Error("cloud catalogue missing required fixtures");
      await mkdir(join(dataDir, "artifacts"), { recursive: true });
      for (const release of releases) {
        const name = decodeURIComponent(new URL(release.artifactUrl).pathname.split("/").at(-1));
        await copyFile(
          join(directory, name),
          join(dataDir, "artifacts", `${release.artifactSha256}.zip`),
        );
      }
      const config = {
        format: 2,
        settings: {
          checkIntervalMinutes: 30,
          autoUpdate: false,
          catalogUrl: "",
          catalogPublicKey: "",
        },
        suppressed: [],
        plugins: releases.map((release) => ({
          id: release.id,
          source: {
            kind: "catalog",
            url: "https://github.com/test/cloud-catalogue.json",
            publicKey,
          },
          sourceStatus: "detached",
          enabled: true,
          installed: release,
          available: release,
        })),
      };
      await writeFile(join(dataDir, "config.json"), JSON.stringify(config));
    },
    async config() {
      return JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    },
  };
  return h;
}
