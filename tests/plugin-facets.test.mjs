import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ControlHost, PluginUi, Lifecycle } from "../sdk/index.ts";
import { PasswordPrompt } from "../plugins/password-pad/contract.ts";
import { passwordFor } from "../plugins/password-pad/src/board.ts";
import passwordFacet from "../plugins/password-pad/src/worker.ts";
import appFacet from "../plugins/app-guard/src/worker.ts";
import infoFacet from "../plugins/system-info/src/worker.ts";

async function hostFixture(t, facets) {
  const directory = await mkdtemp(join(tmpdir(), "chord-plugin-facets-"));
  const shown = [];
  let failPresentation = false;
  const host = await createFacetHost({
    facets: [
      defineFacet({
        id: "test.host",
        setup(env) {
          env.provide(ControlHost, {
            async paths() {
              return { dataDir: directory, bundleDir: directory };
            },
            async native() {
              throw new Error("Native operations forbidden in this probe");
            },
            async log() {},
            async present(visible) {
              if (failPresentation && visible) throw new Error("window failed");
              shown.push(visible);
            },
          });
        },
      }),
      ...facets,
    ],
  });
  t.after(async () => {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    host,
    shown,
    set failPresentation(value) {
      failPresentation = value;
    },
  };
}
const call = (host, method, input = null) =>
  host.services.use(PluginUi).call(method, input, BACKGROUND_CONTEXT);

test("real Chord password service registers stable IDs, approves once, and rejects removed endpoints", async (t) => {
  const { host, shown } = await hostFixture(t, [passwordFacet]);
  assert(host.services.catalogue.some((entry) => entry.serviceId === "study.password.v1"));
  const approved = host.services.use(PasswordPrompt).authorize("打开程序", BACKGROUND_CONTEXT);
  const view = await call(host, "challenge");
  const sequence = [...passwordFor(new Date())].map((letter) => view.cells.indexOf(letter));
  sequence.push(view.cells.indexOf("＃"));
  assert.deepEqual(await call(host, "submit", { id: view.id, revision: view.revision, sequence }), {
    approved: true,
  });
  assert.equal(await approved, true);
  assert.deepEqual(await call(host, "submit", { id: view.id, revision: view.revision, sequence }), {
    approved: false,
  });
  for (const method of ["practice", "cancel"]) await assert.rejects(call(host, method), /无效/);
  await setImmediate();
  assert.equal(shown.at(-1), false);
});

test("X-close denies all pending requests while allowing future authorizations", async (t) => {
  const { host } = await hostFixture(t, [passwordFacet]);
  const service = host.services.use(PasswordPrompt);
  const first = service.authorize("first", BACKGROUND_CONTEXT);
  const second = service.authorize("second", BACKGROUND_CONTEXT);
  await call(host, "window_closed");
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  const abort = new AbortController();
  const third = service.authorize("third", withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
  assert.equal((await call(host, "challenge")).title, "third");
  abort.abort();
  assert.equal(await third, false);
});

test("presentation failure denies requests and the facet remains usable", async (t) => {
  const h = await hostFixture(t, [passwordFacet]);
  h.failPresentation = true;
  assert.equal(
    await h.host.services.use(PasswordPrompt).authorize("failed window", BACKGROUND_CONTEXT),
    false,
  );
  h.failPresentation = false;
  await setImmediate();
  const next = h.host.services.use(PasswordPrompt).authorize("retry", BACKGROUND_CONTEXT);
  assert.equal((await call(h.host, "challenge")).title, "retry");
  await call(h.host, "window_closed");
  assert.equal(await next, false);
});

test("app Lifecycle delegates decisions through the real password service", async (t) => {
  const { host } = await hostFixture(t, [passwordFacet, appFacet]);
  const hook = host.services.use(Lifecycle);
  assert.equal(await hook.before("install", { pluginId: "other" }, BACKGROUND_CONTEXT), true);
  const result = hook.before("desktop.quit", null, BACKGROUND_CONTEXT);
  assert.equal((await call(host, "challenge")).title, "退出控制器");
  await call(host, "window_closed");
  assert.equal(await result, false);
});

test("system-info facet serves host information and persists note.txt", async (t) => {
  const { host } = await hostFixture(t, [infoFacet]);
  const info = await call(host, "info");
  assert.equal(typeof info.hostname, "string");
  assert.equal(typeof info.memoryGiB, "number");
  assert.equal(await call(host, "read_note"), "");
  assert.deepEqual(await call(host, "save_note", "test\n便笺"), { saved: true });
  assert.equal(await call(host, "read_note"), "test\n便笺");
  await assert.rejects(call(host, "save_note", null), /10000/);
  await assert.rejects(call(host, "missing"), /未知/);
});
