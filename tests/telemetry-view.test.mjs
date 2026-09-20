import { test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createDashboardCsp, dashboardCsp } from "../services/telemetry/ui/csp.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { externalizeBootstrap } from "../services/telemetry/ui/build-static.mjs";
import { dashboardDiagnostics, startDashboard } from "../services/telemetry/ui/testing/server.mjs";
import { chromium, expect } from "@playwright/test";
import { diagnosticView, DIAGNOSTIC_LIMIT } from "../services/telemetry/ui/src/lib/diagnostics.js";

test("static bootstrap remains executable under the Worker's same-origin-only CSP", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telemetry-bootstrap-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const base = pathToFileURL(directory + "/");
  const source = 'document.currentScript.parentElement.dataset.started = "yes";';
  await writeFile(new URL("index.html", base), `<div id="app"><script>${source}</script></div>`);
  await externalizeBootstrap(base);
  const html = await readFile(new URL("index.html", base), "utf8");
  assert(!html.includes("<script>"));
  const filename = html.match(/src="\/(bootstrap\.[a-f0-9]+\.js)"/)[1];
  assert.equal(await readFile(new URL(filename, base), "utf8"), source);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("http://bootstrap.test/**", (route) => {
      const script = new URL(route.request().url()).pathname === `/${filename}`;
      return route.fulfill({
        body: script ? source : html,
        contentType: script ? "text/javascript" : "text/html",
        headers: {
          "Content-Security-Policy": createDashboardCsp(),
        },
      });
    });
    await page.goto("http://bootstrap.test/devices/a");
    await expect(page.locator("#app")).toHaveAttribute("data-started", "yes");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
  await writeFile(new URL("index.html", base), "<script>changedBootstrap()</script>");
  await assert.rejects(externalizeBootstrap(base), /Expected one classic SvelteKit SPA bootstrap/);
});

// Run after `vp run --filter @chord-control/telemetry-dashboard build` to test compiled Kit.
const dashboardDist = new URL("../services/telemetry/ui/dist/", import.meta.url);
test.skipIf(!existsSync(new URL("index.html", dashboardDist)))(
  "production dashboard CSP permits only the compiled announcer style through navigation",
  { timeout: 30000 },
  async (t) => {
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, "http://localhost").pathname;
      const asset = path.startsWith("/_app/") || path.startsWith("/bootstrap.");
      try {
        const body = await readFile(new URL(asset ? path.slice(1) : "index.html", dashboardDist));
        response.writeHead(200, {
          "Content-Type": !asset
            ? "text/html"
            : path.endsWith(".css")
              ? "text/css"
              : "text/javascript",
          "Content-Security-Policy": createDashboardCsp(),
        });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
      const errors = [];
      t.onTestFailed(() => console.error("Production CSP errors:", errors));
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.addInitScript(() => {
        window.cspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          window.cspViolations.push(event.effectiveDirective);
        });
      });
      const device = {
        id: "csp-device",
        trusted: true,
        label: "CSP probe device",
        lastSeen: Date.now(),
        ageSeconds: 0,
        report: {
          format: 1,
          client: { hostname: "CSP probe host", username: "probe" },
          process: { uptimeSeconds: 120, rssBytes: 1048576 },
          host: { controller: { version: "0.4.6" } },
        },
      };
      await page.route(`${origin}/api/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/devices")
          return route.fulfill({ json: { devices: [device], receivedAt: Date.now() } });
        if (path === `/api/devices/${device.id}`)
          return route.fulfill({ json: { device, history: [] } });
        return route.fulfill({ status: 404, json: { error: "未找到" } });
      });
      await page.goto(origin);
      await expect(page).toHaveURL(`${origin}/devices`);
      await page.locator("#token").fill("csp-probe-not-a-credential");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await expect(page.locator(".device")).toHaveCount(1);
      const announcer = page.locator("#svelte-announcer");
      await expect(announcer).toHaveCount(1);
      const style = await announcer.getAttribute("style");
      assert(style, "compiled Kit must expose its real announcer style attribute");
      const hash = createHash("sha256").update(style).digest("base64");
      const attributeDirective = dashboardCsp
        .split(";")
        .find((part) => part.trim().startsWith("style-src-attr "))
        .trim();
      assert.equal(attributeDirective, `style-src-attr 'unsafe-hashes' 'sha256-${hash}'`);
      assert(!dashboardCsp.includes("'unsafe-inline'"));
      await expect(announcer).toHaveCSS("width", "1px");
      await expect(announcer).toHaveCSS("height", "1px");
      await expect(announcer).toHaveCSS("clip-path", "inset(50%)");
      await expect(announcer).toHaveCSS("overflow", "hidden");
      await page.locator(".device").getByRole("link", { name: "查看", exact: true }).click();
      await expect(page).toHaveURL(`${origin}/devices/${device.id}`);
      await expect(page.locator("#name")).toHaveText(device.label);
      await expect(announcer).toHaveText(/.+ · Chord/);
      const detailAnnouncement = await announcer.textContent();
      await page.getByRole("link", { name: "返回列表", exact: true }).click();
      await expect(page.locator(".device")).toHaveCount(1);
      await expect(announcer).not.toHaveText(detailAnnouncement);
      await expect(announcer).toHaveCSS("clip-path", "inset(50%)");
      if (process.env.TELEMETRY_CSP_SCREENSHOT)
        await page.screenshot({ path: process.env.TELEMETRY_CSP_SCREENSHOT });
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => window.cspViolations), []);

      // Negative controls: the exception must not authorize other attributes, style tags or scripts.
      const blocked = await browser.newPage();
      await blocked.addInitScript(() => {
        window.cspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          window.cspViolations.push(event.effectiveDirective);
        });
      });
      const policy = createDashboardCsp();
      const nonce = policy.match(/'nonce-([a-f0-9]+)'/)[1];
      const previousNonce = createDashboardCsp().match(/'nonce-([a-f0-9]+)'/)[1];
      assert.notEqual(nonce, previousNonce);
      await blocked.route(`${origin}/blocked`, (route) =>
        route.fulfill({
          contentType: "text/html",
          headers: { "Content-Security-Policy": policy },
          body: `<div id="blocked" style="position: fixed">blocked</div><style>#blocked { display: none }</style><script>window.inlineRan = true</script><script nonce="${previousNonce}">window.staleRan = true</script><script nonce="${nonce}">window.trustedRan = true</script>`,
        }),
      );
      await blocked.goto(`${origin}/blocked`);
      await expect.poll(() => blocked.evaluate(() => window.cspViolations.length)).toBe(4);
      assert.deepEqual((await blocked.evaluate(() => window.cspViolations)).sort(), [
        "script-src-elem",
        "script-src-elem",
        "style-src-attr",
        "style-src-elem",
      ]);
      assert.equal(await blocked.evaluate(() => window.inlineRan), undefined);
      assert.equal(await blocked.evaluate(() => window.staleRan), undefined);
      assert.equal(await blocked.evaluate(() => window.trustedRan), true);
      await expect(blocked.locator("#blocked")).toHaveCSS("position", "static");
      await expect(blocked.locator("#blocked")).toBeVisible();
    } finally {
      await browser?.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

const observedAtMs = 1770000000000;
const createdAt = "133999999999999999";
function event(sequence = 1) {
  return {
    eventId: `event-${sequence}`,
    sequence,
    observedAtMs,
    pluginId: "example",
    operation: "registry.write",
    process: { pid: 42, createdAt },
    api: "RegSetValueExW",
    code: 5,
    target: { kind: "registry", hive: "HKCU", path: "Software\\Example", name: "Enabled" },
    desiredAccess: 2,
    message: "Access denied",
  };
}
function reportHost() {
  return {
    controller: { version: "0.4.6" },
    native: {
      version: "0.4.6",
      schemaVersion: 2,
      observedAtMs,
      process: { pid: 42, createdAt },
      failures: {
        sinceMs: observedAtMs - 1000,
        total: 1,
        retained: 1,
        dropped: 0,
        events: [event()],
      },
    },
    windows: {
      ok: true,
      value: {
        format: 1,
        observedAtMs: observedAtMs + 5000,
        uac: { EnableLUA: { ok: true, value: 0 } },
        processes: [
          {
            role: "host",
            pid: 42,
            ok: true,
            value: {
              pid: 42,
              createdAt,
              elevated: false,
              elevationType: "limited",
              integrity: "medium",
              userSid: "S-1-5-21",
              executable: { ok: true, value: "C:\\app.exe" },
              fileVersion: { ok: false, stage: "version", error: "no version", code: 0 },
            },
          },
        ],
        registry: [],
        vendorEvidence: { status: "unavailable", reason: "No vendor log provider" },
      },
    },
  };
}
function check(eventId, daclAllowed) {
  return {
    eventId,
    ok: true,
    value: {
      requestedAccess: 2,
      checkedAccess: 4,
      checkedPath: "HKCU\\Software",
      ancestorUsed: true,
      daclAllowed,
      grantedAccess: daclAllowed ? 2 : 0,
      pid: 42,
      createdAt,
    },
  };
}

test("old reports retain versions and explicitly require a host update for original failures", () => {
  for (const native of [
    undefined,
    { version: "0.4.4", pid: 42 },
    { schemaVersion: 2 },
    { failures: { events: [event()] } },
  ]) {
    const view = diagnosticView({ controller: { version: "0.4.4" }, native });
    assert.match(view.failureStatus, /原始失败详情不可用.*0\.4\.6/);
    assert.equal(view.failures.length, 0);
    assert.equal(view.uac.length, 4);
    assert(view.uac.every((row) => row[1].startsWith("未知")));
    assert.match(view.registryEmpty, /未知/);
    assert.match(view.vendor, /归因证据：未提供/);
  }
  const host = reportHost();
  assert.equal(diagnosticView(host).summary[2][1], "版本一致");
  host.controller.version = "0.4.5";
  assert.match(diagnosticView(host).summary[2][1], /版本不一致/);
  delete host.native.version;
  assert.match(diagnosticView(host).summary[2][1], /未知/);
});

test("failed Windows probes preserve error, code, stage and collection time without hiding native failures", () => {
  const host = reportHost();
  host.windows = {
    ok: false,
    stage: "spawn",
    error: "helper unavailable",
    code: "ENOENT",
    observedAt: "2026-02-02T12:00:00Z",
  };
  const view = diagnosticView(host);
  assert.match(view.summary[5][1], /采集失败.*helper unavailable.*spawn.*ENOENT/);
  assert.equal(view.summary[6][1], new Date(host.windows.observedAt).toLocaleString());
  assert.equal(view.failures.length, 1);
  assert.match(view.registry[0][2], /未知.*helper unavailable.*ENOENT/);
  assert.match(view.processEmpty, /未知.*helper unavailable/);
  assert(view.uac.every((row) => row[1].startsWith("未知")));
});

test("UAC zero, false elevation, missing fields and optional Outcomes stay distinct", () => {
  const host = reportHost();
  host.windows.value.uac.FilterAdministratorToken = {
    ok: false,
    error: "denied",
    code: 5,
    stage: "read",
  };
  host.windows.value.processes.push({
    role: "controller",
    pid: 43,
    ok: false,
    stage: "OpenProcess",
    error: "gone",
    code: 87,
  });
  let view = diagnosticView(host);
  assert.equal(view.uac[0][1], "0");
  assert.match(view.uac[1][1], /未知.*denied.*read.*5/);
  assert.match(view.uac[2][1], /未知/);
  assert.equal(view.processes[0][4], createdAt);
  assert.equal(view.processes[0][5], "否");
  assert.equal(view.processes[0][9], "C:\\app.exe");
  assert.match(view.processes[0][10], /未知.*no version.*代码：0/);
  assert.match(view.processes[1][2], /未知.*gone.*OpenProcess.*87/);
  assert.equal(view.processes[1][5], "未知");
  delete host.windows.value.processes[0].value.elevated;
  host.windows.value.processes[0].value.fileVersion = "0.4.6";
  view = diagnosticView(host);
  assert.equal(view.processes[0][5], "未知");
  assert.equal(view.processes[0][10], "0.4.6");
});

test("later DACL sampling distinguishes allowed, denied, failed and absent without attributing the failure", () => {
  const host = reportHost();
  host.native.failures.events = [event(1), event(2), event(3), event(4), event(5)];
  host.windows.value.registry = [
    check("event-1", true),
    check("event-2", false),
    { eventId: "event-3", ok: false, stage: "AccessCheck", error: "token unavailable", code: 6 },
    check("event-4", undefined),
  ];
  const view = diagnosticView(host);
  assert.equal(view.registry[0][2], "父键创建权限允许；目标权限待查");
  assert.equal(view.registry[1][2], "权限拒绝");
  assert.equal(view.registry[1][8], "0x0");
  assert.match(view.registry[2][2], /未知.*token unavailable.*AccessCheck.*6/);
  assert.match(view.registry[3][2], /未知.*未提供 DACL 判断/);
  assert.match(view.registry[4][2], /未知.*未提供此事件/);
  assert.equal(view.registry[0][3], new Date(observedAtMs + 5000).toLocaleString());
  assert.equal(view.failures[0][1], new Date(observedAtMs).toLocaleString());
  assert.equal(view.registry[0][5], "是");
  assert.match(view.registry[0][9], new RegExp(createdAt));
  assert.equal(view.registry[0][6], "0x2");
  assert.equal(view.registry[0][7], "0x4");
  assert.match(view.vendor, /归因证据：未提供/);
});

test("failure and recheck tables are bounded to 16 with totals and nullable original facts retained", () => {
  const host = reportHost();
  host.native.failures = {
    sinceMs: observedAtMs,
    total: 30,
    retained: 20,
    dropped: 10,
    events: Array.from({ length: 20 }, (_, index) => event(index)),
  };
  host.windows.value.registry = host.native.failures.events.map((item) =>
    check(item.eventId, true),
  );
  Object.assign(host.native.failures.events.at(-1), {
    api: null,
    code: null,
    target: null,
    desiredAccess: null,
  });
  const view = diagnosticView(host);
  assert.equal(view.failures.length, DIAGNOSTIC_LIMIT);
  assert.equal(view.registry.length, DIAGNOSTIC_LIMIT);
  assert.equal(view.failures[0][0], "event-4 / 4");
  assert.match(view.failureStatus, /总数 30.*保留 20.*丢弃 10.*最多 16/);
  assert.deepEqual(view.failures.at(-1).slice(4, 8), ["未知", "未知", "未知", "未知"]);
  host.native.failures = { sinceMs: observedAtMs, total: 0, retained: 0, dropped: 0, events: [] };
  assert.match(diagnosticView(host).failureEmpty, /此统计周期暂无/);
});

test(
  "dashboard browser flow renders untrusted evidence as text and clears it when opening an old report",
  { timeout: 45000 },
  async (t) => {
    const origin = await startDashboard(t);
    const attack =
      '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
    const host = reportHost();
    host.native.failures.events[0].message = attack;
    host.native.failures.events[0].target.path = attack;
    host.windows.value.uac.EnableLUA = { ok: false, error: attack, stage: "read", code: 5 };
    host.windows.value.processes[0].value.executable = attack;
    host.windows.value.registry = [check("event-1", true)];
    const device = (id, host) => ({
      id,
      trusted: true,
      label: id,
      lastSeen: observedAtMs,
      ageSeconds: 0,
      report: {
        format: 1,
        client: { hostname: "host", username: "user" },
        process: { uptimeSeconds: 1, rssBytes: 1024 },
        host,
      },
    });
    const devices = [
      device("new", host),
      device("old", { controller: { version: "0.4.4" }, native: { version: "0.4.4", pid: 42 } }),
    ];
    const trustChanges = [];
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = dashboardDiagnostics(page, t);
      await page.route(`${origin}/api/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/devices")
          return route.fulfill({ json: { devices, receivedAt: observedAtMs } });
        if (path.endsWith("/trust")) {
          const change = route.request().postDataJSON();
          trustChanges.push(change);
          const id = path.split("/").at(-2);
          devices.find((device) => device.id === id).trusted = change.trusted;
          return route.fulfill({ json: { ok: true } });
        }
        if (path.startsWith("/api/devices/"))
          return route.fulfill({
            json: { device: devices.find((item) => path.endsWith(item.id)), history: [] },
          });
        return route.fulfill({ status: 404, json: { error: "未找到" } });
      });
      await page.goto(`${origin}/devices/new`);
      await page.locator("#token").fill("test-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.locator("#native-failures td").first().waitFor();
      assert((await page.locator("#native-failures").textContent()).includes(attack));
      assert((await page.locator("#uac").textContent()).includes(attack));
      assert((await page.locator("#process-tokens").textContent()).includes(attack));
      assert.equal(await page.locator(".diagnostics img, .diagnostics script").count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      assert.match(
        await page.locator("#registry-checks").textContent(),
        /父键创建权限允许；目标权限待查/,
      );
      await page.getByRole("link", { name: "返回列表", exact: true }).click();
      await page.locator(".device").nth(1).getByRole("link", { name: "查看", exact: true }).click();
      await expect(page.locator("#name")).toHaveText("old");
      assert.match(await page.locator("#failure-status").textContent(), /原始失败详情不可用/);
      assert(!(await page.locator(".diagnostics").textContent()).includes(attack));
      assert.match(await page.locator("#process-tokens").textContent(), /未知/);
      await page.goBack();
      await expect(page.locator(".device")).toHaveCount(2);
      await page.goForward();
      await expect(page.locator("#name")).toHaveText("old");
      await page.getByRole("link", { name: "返回列表", exact: true }).click();
      await page.getByRole("button", { name: "确认状态", exact: true }).click();
      await page.getByRole("option", { name: "待确认", exact: true }).click();
      await expect(page.locator(".device")).toHaveCount(0);
      await page.getByRole("button", { name: "确认状态", exact: true }).click();
      await page.getByRole("option", { name: "全部设备", exact: true }).click();
      const confirm = page
        .locator(".device")
        .first()
        .getByRole("button", { name: "取消确认", exact: true });
      await confirm.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("dialog")).toContainText("客户端 ID：new");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(confirm).toBeFocused();
      await confirm.click();
      await page.getByRole("dialog").getByRole("button", { name: "确定", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator(".device").first()).toContainText("待确认客户端");
      assert.deepEqual(trustChanges, [{ trusted: false, label: "new" }]);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
