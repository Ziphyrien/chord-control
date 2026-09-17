import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { HostKernel } from "../sdk/kernel.ts";
import { createDesktop } from "../sdk/desktop.ts";
import { KernelSession } from "../controller/src/runtime/kernel-session.ts";
import { NativeBridge } from "../controller/src/transport/native-bridge.ts";
import { createTransportHarness } from "./transport-harness.mjs";

const context = BACKGROUND_CONTEXT;
test("kernel sessions gate permissions and close an in-flight acquisition before reuse", async () => {
  const requests = [];
  const bridge = new NativeBridge((event) => requests.push(event));
  const denied = new KernelSession(bridge, "com.test.denied", []);
  await assert.rejects(denied.call("info", null, context), /host-control/);
  assert.equal(requests.length, 0);
  const session = new KernelSession(bridge, "com.test.owner", ["host-control"]);
  const pending = assert.rejects(session.call("tray.visible", false, context), /停止/);
  const closing = session.close();
  bridge.receive({ type: "native_response", id: requests[0].id, ok: true, result: null });
  await setImmediate();
  assert.deepEqual(
    requests.map((r) => r.operation),
    ["host.open", "host.close"],
  );
  assert.equal(requests[0].input.session, requests[1].input.session);
  bridge.receive({ type: "native_response", id: requests[1].id, ok: true, result: null });
  await closing;
  await pending;
  await assert.rejects(session.call("info", null, context), /停止/);
  bridge.close();
});

test("ordinary plugins call desktop primitives directly through their bundled SDK", async (t) => {
  const calls = [];
  const host = await createFacetHost({
    facets: [
      defineFacet({
        id: "test.kernel",
        setup(env) {
          env.provide(HostKernel, {
            async call(operation, input) {
              calls.push({ operation, input });
              return operation === "updates.install" ? { started: true } : null;
            },
          });
        },
      }),
    ],
  });
  t.onTestFinished(() => host.dispose());
  const api = createDesktop(host.services.use(HostKernel));
  await api.setTrayVisible(false, context);
  await api.setTaskbarVisible(false, context);
  assert.deepEqual(await api.installUpdate(context), { started: true });
  assert.deepEqual(calls, [
    { operation: "tray.visible", input: false },
    { operation: "window.taskbar", input: false },
    { operation: "updates.install", input: null },
  ]);
  await assert.rejects(api.setTrayVisible("false", context), /布尔值/);
});

const fixtureContext =
  'const context={abortSignal:undefined,value(){return undefined},toString(){return "fixture"}};';
const providerSource = (version, fail = false) => `${fixtureContext}
exports.default={id:"test.api",setup(env){
 const kernel=env.use({id:"chord-control.kernel.v1",local:false});
 env.provide({id:"chord-control.ui",local:false},{call:async()=>"provider"});
 env.provide({id:"test.desktop.v1",local:false},{
  call:async(method,input,ctx)=>{
   if(method==="version")return "${version}";
   if(method==="hide")return kernel.call("tray.visible",false,ctx);
   ${version === "2.0.0" ? 'if(method==="new_api")return {added:true,input};' : ""}
   throw new Error("method unavailable");
  }
 });
 ${fail ? 'env.onActivate(()=>{throw new Error("bad API candidate")});' : ""}
}};`;
const consumerSource = (id) => `${fixtureContext}
exports.default={id:"${id}",setup(env){
 const api=env.use({id:"test.desktop.v1",local:false});
 env.provide({id:"chord-control.ui",local:false},{call:(method,input)=>api.call(method,input,context)});
}};`;

test(
  "API modules add methods live, preserve caller grants and recover failed replacements",
  { timeout: 40000 },
  async (t) => {
    const h = await createTransportHarness({ native: () => null });
    t.onTestFinished(() => h.close());
    const provider = (version, fail = false) =>
      h.fixture(version, {
        id: "com.test.api",
        source: providerSource(version, fail),
        permissions: ["host-control"],
        services: { provides: ["test.desktop.v1"], requires: [] },
      });
    const consumer = await h.fixture("1.0.0", {
      id: "com.test.consumer",
      source: consumerSource("com.test.consumer"),
      permissions: ["host-control"],
      services: { provides: [], requires: ["test.desktop.v1"] },
    });
    const denied = await h.fixture("1.0.0", {
      id: "com.test.denied",
      source: consumerSource("com.test.denied"),
      services: { provides: [], requires: ["test.desktop.v1"] },
    });
    const independent = await h.fixture("1.0.0", { id: "com.test.independent" });
    const initial = await provider("1.0.0");
    h.catalogue([consumer, initial, denied, independent]);
    await h.start();
    await h.command({
      type: "set_settings",
      settings: {
        autoUpdate: true,
        checkIntervalMinutes: 30,
        catalogUrl: `${h.baseUrl}/catalog.json`,
        catalogPublicKey: h.publicKey,
      },
    });
    assert(
      h.snapshot.plugins.every((item) => item.running),
      JSON.stringify(h.snapshot.plugins),
    );
    const pid = h.pid;
    const independentPage = await h.command({ type: "plugin_ui", pluginId: independent.id });
    const call = (method, input = null, pluginId = consumer.id) =>
      h.command({ type: "plugin_call", pluginId, method, input });
    assert.equal(await call("version"), "1.0.0");
    await assert.rejects(call("new_api"), /unavailable/);
    await assert.rejects(call("hide", null, denied.id), /host-control/);
    await call("hide");
    const lease = h.native.find((r) => r.operation === "host.open");
    assert.equal(lease.pluginId, consumer.id, "resource belongs to caller, not provider");
    h.catalogue([consumer, await provider("2.0.0"), denied, independent]);
    await h.command({ type: "check_updates" });
    assert.equal(h.pid, pid, "same controller process survives API upgrade");
    assert.equal((await fetch(independentPage.url)).status, 200, "unrelated plugin stayed active");
    assert.deepEqual(await call("new_api", { live: true }), { added: true, input: { live: true } });
    assert(
      h.native.some((r) => r.operation === "host.close" && r.input.session === lease.input.session),
    );
    await call("hide");
    const leases = h.native.filter((r) => r.operation === "host.open");
    assert.notEqual(leases.at(-1).input.session, lease.input.session);
    h.catalogue([consumer, await provider("3.0.0", true), denied, independent]);
    assert.equal((await h.command({ type: "check_updates" })).failures, 1);
    assert.equal(await call("version"), "2.0.0");
    assert.equal(h.pid, pid);
    await h.stop();
    const opened = h.native.filter((r) => r.operation === "host.open").map((r) => r.input.session);
    const closed = h.native.filter((r) => r.operation === "host.close").map((r) => r.input.session);
    assert.deepEqual(new Set(closed), new Set(opened));
    assert.equal(closed.length, opened.length);
  },
);
