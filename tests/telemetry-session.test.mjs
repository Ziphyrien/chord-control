import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { dashboardDiagnostics, startDashboard } from "../services/telemetry/ui/testing/server.mjs";
import { chromium, expect } from "@playwright/test";
import { createSession } from "../services/telemetry/ui/src/lib/session.js";
import { createClient } from "../services/telemetry/ui/src/lib/client.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const listResult = (id) => ({ devices: [{ id }], receivedAt: 1 });
const detailResult = (id) => ({ device: { id, report: {} }, history: [] });
const pending = { connected: true, pending: { requestId: "report-1" } };
function harness(create = createSession) {
  const calls = [],
    states = [],
    scheduled = new Map();
  let timerId = 0;
  const session = create({
    request(path, options) {
      const response = deferred();
      calls.push({
        path,
        options,
        reject: response.reject,
        respond(value, status = 200) {
          response.resolve({ ok: status < 400, status, json: async () => value });
        },
        respondWithBody(body) {
          response.resolve({ ok: true, json: () => body });
        },
      });
      // Deliberately ignore abort: guards must also reject late responses.
      return response.promise;
    },
    onState(state) {
      states.push(state);
    },
    timers: {
      setTimeout(callback, delay) {
        const id = ++timerId;
        scheduled.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        scheduled.delete(id);
      },
    },
  });
  return {
    session,
    calls,
    states,
    scheduled,
    get state() {
      return states.at(-1);
    },
    tick(expectedDelay) {
      assert.equal(scheduled.size, 1);
      const [id, timer] = scheduled.entries().next().value;
      assert.equal(timer.delay, expectedDelay);
      scheduled.delete(id);
      return timer.callback();
    },
  };
}
async function login(h) {
  const done = h.session.login("secret-value", "host name");
  h.calls.at(-1).respond(listResult("a"));
  await done;
}
async function open(h, id = "a") {
  const done = h.session.detail(id);
  h.calls.at(-1).respond(detailResult(id));
  await done;
}
async function collecting(h, live = pending) {
  await login(h);
  await open(h);
  const done = h.session.requestReport();
  h.calls.at(-1).respond(live);
  await done;
}

test("late login list cannot reopen workspace after logout, including delayed JSON", async () => {
  for (const delayedBody of [false, true]) {
    const h = harness();
    const done = h.session.login("old-secret");
    const request = h.calls[0];
    const body = deferred();
    if (delayedBody) {
      request.respondWithBody(body.promise);
      await Promise.resolve();
    }
    h.session.logout();
    const changes = h.states.length;
    assert(request.options.signal.aborted);
    if (delayedBody) body.resolve(listResult("old"));
    else request.respond(listResult("old"));
    await done;
    assert.equal(h.states.length, changes);
    assert.equal(h.state.authenticated, false);
    assert.equal(h.state.view, "login");
    assert.equal(h.state.list, null);
  }
});

test("new login remains authoritative while old login succeeds or fails", async () => {
  for (const fails of [false, true]) {
    const h = harness();
    const old = h.session.login("old-secret");
    const fresh = h.session.login("new-secret");
    assert(h.calls[0].options.signal.aborted);
    assert.equal(h.calls[1].options.headers.Authorization, "Bearer new-secret");
    h.calls[1].respond(listResult("fresh"));
    await fresh;
    const changes = h.states.length;
    if (fails) h.calls[0].reject(new Error("old unauthorized"));
    else h.calls[0].respond(listResult("old"));
    await old;
    assert.equal(h.states.length, changes);
    assert.equal(h.state.list.devices[0].id, "fresh");
    assert.equal(h.state.error, "");
  }
});

test("out-of-order list/detail navigation only renders the most recent destination", async () => {
  for (const [first, second] of [
    ["list", "list"],
    ["detail", "detail"],
    ["list", "detail"],
    ["detail", "list"],
  ]) {
    const h = harness();
    await login(h);
    const old = h.session[first]("old");
    const oldCall = h.calls.at(-1);
    const fresh = h.session[second]("fresh");
    assert(oldCall.options.signal.aborted);
    h.calls.at(-1).respond(second === "list" ? listResult("fresh") : detailResult("fresh"));
    await fresh;
    const changes = h.states.length;
    oldCall.respond(first === "list" ? listResult("old") : detailResult("old"));
    await old;
    assert.equal(h.states.length, changes);
    assert.equal(h.state.view, second);
    assert.equal(h.state.selected, second === "detail" ? "fresh" : null);
    assert.equal(
      second === "list" ? h.state.list.devices[0].id : h.state.detail.device.id,
      "fresh",
    );
  }
});

test("navigation, logout and dispose clear scheduled polls and abort their request scope", async () => {
  for (const action of ["list", "detail", "logout", "dispose"]) {
    const h = harness();
    await collecting(h);
    const request = h.calls.at(-1);
    const staleTimer = h.scheduled.values().next().value.callback;
    const done = h.session[action]("b");
    assert.equal(h.scheduled.size, 0);
    assert(request.options.signal.aborted);
    const count = h.calls.length;
    await staleTimer();
    assert.equal(h.calls.length, count);
    if (action === "list" || action === "detail")
      h.calls.at(-1).respond(action === "list" ? listResult("b") : detailResult("b"));
    await done;
    assert.equal(h.state.requestStatus, "");
    if (action === "dispose") {
      await h.session.login("unused");
      await h.session.list();
      await h.session.detail("a");
      await h.session.requestReport();
      await h.session.setTrust("a", true, "a");
      h.session.logout();
      h.session.dispose();
      assert.equal(h.calls.length, count);
    }
  }
});

test("a poll resolving after navigation cannot refresh the old device or schedule another poll", async () => {
  for (const response of [pending, { connected: true, pending: null }]) {
    const h = harness();
    await collecting(h);
    const polling = h.tick(1500);
    const liveCall = h.calls.at(-1);
    await open(h, "b");
    const changes = h.states.length,
      count = h.calls.length;
    liveCall.respond(response);
    await polling;
    assert(liveCall.options.signal.aborted);
    assert.equal(h.states.length, changes);
    assert.equal(h.calls.length, count);
    assert.equal(h.scheduled.size, 0);
    assert.equal(h.state.detail.device.id, "b");
  }
});

test("late request-report response after logout cannot restart polling", async () => {
  const h = harness();
  await login(h);
  await open(h);
  const done = h.session.requestReport();
  const call = h.calls.at(-1);
  h.session.logout();
  const changes = h.states.length;
  call.respond(pending);
  await done;
  assert.equal(h.states.length, changes);
  assert.equal(h.scheduled.size, 0);
});

test("polling stops after 15 attempts without deleting the server pending request", async () => {
  const h = harness();
  await collecting(h, { ...pending, connected: false });
  assert.equal(h.state.requestStatus, "等待设备连接");
  for (let attempt = 0; attempt < 15; attempt++) {
    const done = h.tick(attempt === 0 ? 1500 : 2000);
    h.calls.at(-1).respond(pending);
    await done;
    assert.equal(h.state.requestStatus, attempt < 14 ? "正在采集…" : "稍后刷新查看结果");
  }
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/live")).length, 15);
  assert.equal(h.calls.filter((call) => call.options.method === "POST").length, 1);
  assert(!h.calls.some((call) => call.options.method === "DELETE"));
});

test("completed collection refreshes detail, with refresh response also guarded after navigation", async () => {
  for (const navigate of [false, true]) {
    const h = harness();
    await collecting(h);
    const polling = h.tick(1500);
    h.calls.at(-1).respond({ connected: true, pending: null });
    // Drain only promise continuations, never a real timer.
    for (let turn = 0; turn < 8 && h.calls.at(-1).path.endsWith("/live"); turn++)
      await Promise.resolve();
    const refresh = h.calls.at(-1);
    assert.equal(refresh.path, "/api/devices/a");
    if (navigate) await open(h, "b");
    refresh.respond(detailResult("refreshed-a"));
    await polling;
    assert.equal(h.state.detail.device.id, navigate ? "b" : "refreshed-a");
    assert.equal(h.state.requestStatus, navigate ? "" : "采集完成");
    assert.equal(h.scheduled.size, 0);
  }
});

test("request-report and live errors are handled without runaway polling or misleading completion", async () => {
  for (const duringPoll of [false, true]) {
    for (const network of [false, true]) {
      const h = harness();
      await login(h);
      await open(h);
      let done = h.session.requestReport();
      if (duringPoll) {
        h.calls.at(-1).respond(pending);
        await done;
        done = h.tick(1500);
      }
      if (network) h.calls.at(-1).reject(new TypeError("Failed to fetch"));
      else h.calls.at(-1).respond({ error: "采集请求失败" }, 503);
      await done;
      assert.equal(h.state.error, network ? "连接已断开" : "采集请求失败");
      assert.equal(h.state.requestStatus, "稍后刷新查看结果");
      assert.equal(h.state.busy, false);
      assert.equal(h.scheduled.size, 0);
      assert.equal(h.state.detail.device.id, "a");
      // A retry starts a fresh, bounded collection.
      done = h.session.requestReport();
      h.calls.at(-1).respond(pending);
      await done;
      assert.equal(h.state.error, "");
      assert.equal(h.scheduled.size, 1);
      h.session.dispose();
    }
  }
});

test("trust updates use the session and cannot redirect a newer navigation", async () => {
  const h = harness();
  await login(h);
  const trust = h.session.setTrust("a", true, "Client A");
  const call = h.calls.at(-1);
  assert.equal(call.path, "/api/devices/a/trust");
  assert.deepEqual(JSON.parse(call.options.body), { trusted: true, label: "Client A" });
  await open(h, "b");
  const count = h.calls.length;
  call.respond({ ok: true });
  await trust;
  assert.equal(h.calls.length, count);
  assert.equal(h.state.detail.device.id, "b");
  const fresh = h.session.setTrust("b", false, "Client B");
  h.calls.at(-1).respond({ ok: true });
  for (let turn = 0; turn < 8 && h.calls.at(-1).path.endsWith("/trust"); turn++)
    await Promise.resolve();
  assert.equal(h.calls.at(-1).path, "/api/devices?q=host%20name");
  h.calls.at(-1).respond(listResult("b"));
  await fresh;
  assert.equal(h.state.view, "list");
});

test("replacing a collection cancels its pending POST before starting a new timer", async () => {
  const h = harness();
  await login(h);
  await open(h);
  const old = h.session.requestReport();
  const oldCall = h.calls.at(-1);
  const fresh = h.session.requestReport();
  h.calls.at(-1).respond(pending);
  await fresh;
  const changes = h.states.length;
  oldCall.respond({ ...pending, connected: false });
  await old;
  assert(oldCall.options.signal.aborted);
  assert.equal(h.states.length, changes);
  assert.equal(h.scheduled.size, 1);
  assert.equal(h.state.requestStatus, "正在采集…");
});

test("an already queued stale timer cannot hide the current timer from logout cleanup", async () => {
  const h = harness();
  await collecting(h);
  const staleCallback = h.scheduled.values().next().value.callback;
  const fresh = h.session.requestReport();
  h.calls.at(-1).respond(pending);
  await fresh;
  const count = h.calls.length;
  await staleCallback();
  assert.equal(h.calls.length, count);
  assert.equal(h.scheduled.size, 1);
  h.session.logout();
  assert.equal(h.scheduled.size, 0);
});

test(
  "browser session clears sensitive views on logout, rejects late refresh, and supports a fresh login",
  { timeout: 45000 },
  async (t) => {
    const origin = await startDashboard(t);
    const device = {
      id: "a",
      label: "Client A",
      trusted: true,
      ageSeconds: 0,
      lastSeen: 1,
      report: {
        client: { hostname: "host", username: "user" },
        process: { uptimeSeconds: 1, rssBytes: 1024 },
        host: {},
      },
    };
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = dashboardDiagnostics(page, t);
      let holdList = false;
      const held = deferred();
      await page.route(`${origin}/api/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/devices") {
          if (holdList) {
            held.resolve(route);
            return;
          }
          return route.fulfill({ json: { devices: [device], receivedAt: 1 } });
        }
        if (path.endsWith("/request-report"))
          return route.fulfill({ status: 503, json: { error: "采集请求失败" } });
        if (path === "/api/devices/a") return route.fulfill({ json: { device, history: [] } });
        return route.fulfill({ status: 404, json: { error: "未找到" } });
      });
      await page.goto(`${origin}/`);
      await expect(page).toHaveURL(`${origin}/devices`);
      async function enter() {
        await page.locator("#token").fill("browser-secret");
        await page.locator("#login button").click();
        await page.locator(".device").waitFor();
        await expect(page.locator("#token")).toHaveCount(0);
      }
      await enter();
      await page.getByRole("link", { name: "查看", exact: true }).click();
      await page.getByRole("button", { name: "完整报告", exact: true }).click();
      await expect(page.locator("#raw")).toContainText("hostname");
      await page.locator("#request").click();
      await page.waitForFunction(
        () => document.getElementById("error").textContent === "采集请求失败",
      );
      assert.equal(await page.locator("#request-status").textContent(), "稍后刷新查看结果");
      holdList = true;
      await page.locator("#close").click();
      const late = await held.promise;
      await page.locator("#logout").click();
      await late.fulfill({ json: { devices: [device], receivedAt: 1 } });
      await expect(page.locator("#workspace")).toHaveCount(0);
      await expect(page.locator("#login")).toBeVisible();
      await expect(page.locator("#raw")).toHaveCount(0);
      await expect(page.locator("#devices")).toHaveCount(0);
      await expect(page.locator("#request-status")).toHaveCount(0);
      holdList = false;
      await enter();
      // A cached page must be able to log in again when restored.
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
      );
      assert.equal(await page.locator("#workspace").isVisible(), false);
      await enter();
      assert.deepEqual(
        await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
        { local: 0, session: 0 },
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

function clientHarness() {
  return harness((options) => {
    const client = createClient(options);
    return { ...client.session, client };
  });
}

test("route adapter opens the latest deep link after login and ignores superseded credentials", async () => {
  const h = clientHarness();
  const client = h.session.client;
  client.route({ id: "old", query: "first" });
  const oldLogin = client.login("old-secret");
  client.route({ id: "fresh", query: "second" });
  const freshLogin = client.login("new-secret");
  h.calls[1].respond(listResult("fresh"));
  for (let turn = 0; turn < 12 && h.calls.length < 3; turn++) await Promise.resolve();
  assert.equal(h.calls[2].path, "/api/devices/fresh");
  assert.equal(h.calls[2].options.headers.Authorization, "Bearer new-secret");
  h.calls[2].respond(detailResult("fresh"));
  await freshLogin;
  const count = h.calls.length;
  h.calls[0].respond(listResult("old"));
  await oldLogin;
  assert.equal(h.calls.length, count);
  assert.equal(h.state.selected, "fresh");
  assert.equal(h.state.detail.device.id, "fresh");
});

test("route transition cancels polling immediately and late detail cannot reappear before the next route", async () => {
  const h = clientHarness();
  await collecting(h);
  const client = h.session.client;
  const polling = h.tick(1500);
  const stale = h.calls.at(-1);
  client.cancel();
  assert(stale.options.signal.aborted);
  assert.equal(h.state.selected, null);
  assert.equal(h.state.detail, null);
  assert.equal(h.state.busy, false);
  stale.respond(pending);
  await polling;
  assert.equal(h.scheduled.size, 0);
  const next = client.route({ id: "b", query: "" });
  h.calls.at(-1).respond(detailResult("b"));
  await next;
  assert.equal(h.state.detail.device.id, "b");
  client.logout();
  assert.equal(h.state.authenticated, false);
});

test("logout during deep-link login prevents subsequent detail loading", async () => {
  const h = clientHarness();
  h.session.client.route({ id: "a", query: "" });
  const login = h.session.client.login("secret");
  h.session.client.logout();
  h.calls[0].respond(listResult("a"));
  await login;
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.authenticated, false);
});

test("credentials appear only in request headers, never public state or request URLs", async () => {
  const h = harness();
  await login(h);
  await open(h);
  assert.equal(h.calls[0].path, "/api/devices?q=host%20name");
  for (const call of h.calls) {
    assert.equal(call.options.headers.Authorization, "Bearer secret-value");
    assert.equal(call.options.cache, "no-store");
    assert(!call.path.includes("secret-value"));
  }
  assert(!JSON.stringify(h.states).includes("secret-value"));
  h.session.logout();
  const count = h.calls.length;
  await h.session.list();
  await h.session.detail("a");
  await h.session.requestReport();
  await h.session.setTrust("a", false, "a");
  assert.equal(h.calls.length, count);
});
