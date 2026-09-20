import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { PadSession } from "../plugins/password-pad/ui/src/session.ts";
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function board(revision = 0, id = "one") {
  const cells = Array(36).fill("2");
  cells[20] = "W";
  cells[5] = "＃";
  return { id, revision, title: "Authorize", size: 6, expiresAt: Date.now() + 120000, cells };
}
async function tick() {
  await setImmediate();
}
function fixture(t) {
  const requests = [],
    states = [];
  const session = new PadSession(
    (method, input) => {
      const reply = deferred();
      requests.push({ method, input, ...reply });
      return reply.promise;
    },
    (state) => states.push(state),
  );
  t.onTestFinished(() => session.pause());
  session.start();
  return {
    session,
    requests,
    states,
    get state() {
      return states.at(-1);
    },
  };
}

test("same revision polls preserve repeated clicks; submit freezes RPC and rendering", async (t) => {
  const h = fixture(t);
  h.requests[0].resolve(board());
  await tick();
  await h.session.select(0);
  await h.session.select(0);
  await h.session.select(20);
  assert.equal(h.state.count, 3);
  const poll = h.session.refresh();
  h.requests[1].resolve(board());
  await poll;
  assert.equal(h.state.count, 3);
  const submit = h.session.select(5);
  assert.equal(h.state.busy, true);
  assert.deepEqual(h.requests[2].input, { id: "one", revision: 0, sequence: [0, 0, 20, 5] });
  await h.session.select(0);
  await h.session.select(5);
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve({ approved: false });
  await tick();
  assert.equal(h.state.view, null);
  assert.equal(h.requests[3].method, "challenge");
  h.requests[3].resolve(board(1));
  await submit;
  assert.equal(h.state.view.revision, 1);
  assert.equal(h.state.count, 0);
  assert.equal(h.state.busy, false);
});

test("poll issued before submission cannot resurrect stale cells or skip the fresh read", async (t) => {
  const h = fixture(t);
  h.requests[0].resolve(board());
  await tick();
  const poll = h.session.refresh();
  const submit = h.session.select(5);
  h.requests[2].resolve({ approved: true });
  await tick();
  assert.equal(h.state.view, null);
  h.requests[1].resolve(board(99, "obsolete"));
  await poll;
  await tick();
  assert.equal(h.requests[3].method, "challenge");
  h.requests[3].resolve(null);
  await submit;
  assert.equal(h.state.view, null);
  assert.equal(
    h.states.some((state) => state.view?.id === "obsolete"),
    false,
  );
});

test("transport failures drop input and fetch a fresh revision", async (t) => {
  const h = fixture(t);
  h.requests[0].resolve(board());
  await tick();
  await h.session.select(0);
  const submit = h.session.select(5);
  h.requests[1].reject(new Error("transport lost"));
  await tick();
  assert.equal(h.state.count, 0);
  assert.match(h.state.message, /transport lost/);
  h.requests[2].resolve(board(1));
  await submit;
  assert.equal(h.state.view.revision, 1);
});

test("pagehide suppresses late replies and pageshow resumes polling", async (t) => {
  const h = fixture(t);
  h.session.pause();
  h.requests[0].resolve(board());
  await tick();
  assert.equal(h.state.view, null);
  assert.equal(h.state.busy, true);
  h.session.start();
  h.requests[1].resolve(board(2));
  await tick();
  assert.equal(h.state.view.revision, 2);
  h.session.pause();
  const count = h.requests.length;
  await h.session.refresh();
  await h.session.select(5);
  assert.equal(h.requests.length, count);
});

test("initial loading is busy and a successful read clears a prior read failure", async (t) => {
  const h = fixture(t);
  assert.equal(h.state.busy, true);
  assert.equal(h.state.message, "");
  h.requests[0].reject(new Error("temporary read failure"));
  await tick();
  assert.match(h.state.message, /temporary read failure/);
  const retry = h.session.refresh();
  h.requests[1].resolve(board());
  await retry;
  assert.equal(h.state.busy, false);
  assert.equal(h.state.message, "");
  assert.equal(h.state.view.id, "one");
});

test("exhausted verification keeps the completion hint after the empty refresh", async (t) => {
  const h = fixture(t);
  h.requests[0].resolve(board());
  await tick();
  const submit = h.session.select(5);
  h.requests[1].resolve({ approved: false, retryable: false });
  await tick();
  h.requests[2].resolve(null);
  await submit;
  assert.equal(h.state.view, null);
  assert.match(h.state.message, /已结束/);
});

test("input limit, backspace and malformed challenge fail safely", async (t) => {
  const h = fixture(t);
  h.requests[0].resolve(board());
  await tick();
  for (let index = 0; index < 35; index++) await h.session.select(0);
  assert.equal(h.state.count, 32);
  h.session.backspace();
  assert.equal(h.state.count, 31);
  const poll = h.session.refresh();
  h.requests[1].resolve({ ...board(1), cells: Array(36).fill("＃") });
  await poll;
  assert.equal(h.state.view, null);
  assert.equal(h.state.count, 0);
  assert.match(h.state.message, /加载失败/);
});
