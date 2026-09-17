import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync } from "fflate";
import { signingBytes } from "../shared/signing.ts";

// Execute only on a disposable Windows CI runner. No builds or existing installations are used.
assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Native probe requires an isolated CI runner");
const artifact = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "chord-api-probe-"));
const data = join(process.env.LOCALAPPDATA, "ChordControl");
await mkdir(data); // Refuse to overwrite another session's data.
let child;
try {
  await copyFile(
    join(artifact, "target/release/chord-control.exe"),
    join(root, "chord-control.exe"),
  );
  await copyFile(
    join(artifact, "binaries/plugin-controller-x86_64-pc-windows-msvc.exe"),
    join(root, "plugin-controller.exe"),
  );
  await mkdir(join(data, "artifacts"));
  await writeFile(join(data, "first-run-complete"), "1");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const plugins = [];
  for (const suffix of ["a", "b"]) {
    const id = `com.test.native-${suffix}`;
    const source = `const fs=require("node:fs/promises"),path=require("node:path"),http=require("node:http");
const context={abortSignal:undefined,value(){return undefined},toString(){return "native-probe"}};
exports.default={id:${JSON.stringify(id)},setup(env){
 const host=env.use({id:"chord-control.host",local:false});
 const kernel=env.use({id:"chord-control.kernel.v1",local:false});
 let server;
 env.onActivate(async()=>{
  const paths=await host.paths(context);
  server=http.createServer(async(req,res)=>{
   try{let body="";for await(const chunk of req)body+=chunk;
    const {operation,input}=JSON.parse(body);
    const result=await kernel.call(operation,input,context);
    res.end(JSON.stringify({ok:true,result}));
   }catch(error){res.end(JSON.stringify({ok:false,error:String(error)}));}
  });
  await new Promise(done=>server.listen(0,"127.0.0.1",done));
  await fs.writeFile(path.join(paths.dataDir,"ready.json"),JSON.stringify({port:server.address().port}));
 });
 env.own(async()=>{if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}});
}};`;
    const hash = createHash("sha256").update(source).digest();
    const file = `worker-${hash.toString("hex")}.cjs`;
    const bundle = {
      format: "chord.facet-bundle",
      formatVersion: 2,
      plugin: { id, version: "1.0.0" },
      entries: {
        worker: { file, integrity: `sha256-${hash.toString("base64")}`, externalImports: [] },
      },
    };
    const zip = Buffer.from(
      zipSync({
        "chord-facets.json": Buffer.from(JSON.stringify(bundle)),
        [file]: Buffer.from(source),
      }),
    );
    const unsigned = {
      id,
      name: id,
      version: "1.0.0",
      artifactUrl: "https://example.test/native.zip",
      artifactSha256: createHash("sha256").update(zip).digest("hex"),
      permissions: ["host-control"],
    };
    const manifest = {
      ...unsigned,
      signature: sign(null, signingBytes(unsigned), keys.privateKey).toString("base64"),
    };
    await writeFile(join(data, "artifacts", `${manifest.artifactSha256}.zip`), zip);
    plugins.push({
      id,
      source: { kind: "catalog", url: "https://example.test/catalog.json", publicKey },
      sourceStatus: "detached",
      enabled: true,
      installed: manifest,
      available: manifest,
    });
  }
  await writeFile(
    join(data, "config.json"),
    JSON.stringify({
      format: 2,
      settings: {
        checkIntervalMinutes: 30,
        autoUpdate: false,
        catalogUrl: "",
        catalogPublicKey: "",
      },
      plugins,
      suppressed: [],
    }),
  );
  child = spawn(join(root, "chord-control.exe"), ["--background"], { cwd: root, stdio: "ignore" });
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const ports = [];
  for (const plugin of plugins) {
    let ready;
    for (let i = 0; i < 100; i++) {
      try {
        ready = JSON.parse(await readFile(join(data, "data", plugin.id, "ready.json"), "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      if (child.exitCode !== null) throw new Error(`Desktop exited early: ${child.exitCode}`);
      await delay(300);
    }
    assert(ready, "Native API fixture did not start");
    ports.push(ready.port);
  }
  const call = async (owner, operation, input = null) => {
    const response = await fetch(`http://127.0.0.1:${ports[owner]}`, {
      method: "POST",
      body: JSON.stringify({ operation, input }),
      signal: AbortSignal.timeout(20000),
    });
    const reply = await response.json();
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  };
  const info = await call(0, "info");
  assert.equal(info.protocol, 1);
  assert.equal(info.platform, "windows");
  assert.equal(info.pid, child.pid);
  assert(BigInt(info.mainWindowHandle) > 0n);
  assert(info.operations.includes("updates.install"));
  await call(0, "tray.visible", false);
  await call(0, "window.taskbar", false);
  let state = await call(1, "window.state");
  assert.equal(state.trayVisible, false);
  assert.equal(state.taskbarVisible, false);
  await call(1, "tray.visible", false);
  await call(0, "tray.visible", true);
  await call(0, "window.taskbar", true);
  state = await call(1, "window.state");
  assert.equal(state.trayVisible, false, "second owner's hidden claim remains");
  assert.equal(state.taskbarVisible, true);
  await call(1, "tray.visible", true);
  state = await call(0, "window.state");
  assert.equal(state.trayVisible, true);
  await assert.rejects(call(0, "tray.visible", "false"), /布尔值/);
  await assert.rejects(call(0, "missing.operation"), /不支持/);
  await call(0, "window.open");
  for (let i = 0; i < 50; i++) {
    state = await call(0, "window.state");
    if (state.visible) break;
    await delay(100);
  }
  assert.equal(state.visible, true);
  await call(0, "window.minimize");
  assert.equal((await call(0, "window.state")).minimized, true);
  await call(0, "window.hide");
  assert.equal((await call(0, "window.state")).visible, false);
  const update = await call(0, "updates.status");
  assert.equal(typeof update.busy, "boolean");
  await call(0, "app.quit");
  const code = await Promise.race([
    exit,
    delay(30000, undefined, { ref: false }).then(() => {
      throw new Error("Desktop did not exit");
    }),
  ]);
  assert.equal(code, 0);
  console.log(
    JSON.stringify({
      version: info.hostVersion,
      protocol: info.protocol,
      checks:
        "Native discovery, real Tauri tray/taskbar visibility, multiple owners, invalid inputs, update status, graceful plugin disposal and exit passed",
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    await promisify(execFile)(join(root, "chord-control.exe"), ["--maintenance-stop"], {
      timeout: 55000,
    }).catch(() => child.kill());
  }
  for (const name of ["desktop.log", "controller.log"]) {
    try {
      console.error((await readFile(join(data, name), "utf8")).slice(-5000));
    } catch {
      /* optional diagnostics */
    }
  }
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
