import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { buildPluginUi } from "../scripts/build-plugin-ui.mjs";
import { deferred } from "./helpers.mjs";

test(
  "inline Kit plugin pages preserve drafts, cancel on page hide and display queued telemetry failures",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "chord-ui-"));
    const browser = await chromium.launch({ headless: true });
    t.onTestFinished(async () => {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    });
    const html = {};
    await Promise.all(
      ["system-info", "study-guard", "password-pad", "telemetry"].map(async (name) => {
        const directory = resolve("plugins", name),
          pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        const bundleDir = join(root, name);
        await mkdir(bundleDir);
        await buildPluginUi({
          directory,
          bundleDir,
          scratch: root,
          control: pkg.control,
          title: pkg.control.name,
          sourcePath: async (dir, name) => join(dir, name),
        });
        html[name] = await readFile(join(bundleDir, "ui.html"), "utf8");
        if (name === "password-pad") {
          const repeated = join(root, "password-repeat");
          await mkdir(repeated);
          await buildPluginUi({
            directory,
            bundleDir: repeated,
            scratch: root,
            control: pkg.control,
            title: pkg.control.name,
            sourcePath: async (dir, name) => join(dir, name),
          });
          assert.equal(
            await readFile(join(repeated, "ui.html"), "utf8"),
            html[name],
            "same plugin source must produce identical signed UI bytes",
          );
        }
        assert.equal(pkg.control.uiProject, "ui/vite.config.ts");
        assert(!html[name].includes("PLUGIN_SCRIPT"));
        assert.match(html[name], /__sveltekit_/);
        assert.match(html[name], /<style[\s>]/);
        assert(!/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/i.test(html[name]));
        assert.deepEqual(await readdir(bundleDir), ["ui.html"]);
      }),
    );
    const saved = deferred(),
      saving = deferred(),
      cancelSaving = deferred(),
      releaseCancelledSave = deferred();
    t.onTestFinished(() => releaseCancelledSave.resolve());
    let sends = 0,
      reads = 0,
      passwordReads = 0;
    const errors = [];
    const unexpectedRequests = [];
    const cspViolations = [];
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const request = window.fetch;
      globalThis.cancelledSave = false;
      window.fetch = async (...args) => {
        try {
          return await request(...args);
        } catch (error) {
          if (args[1]?.body?.includes("cancel on hide") && error.name === "AbortError")
            globalThis.cancelledSave = true;
          throw error;
        }
      };
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/Content Security Policy|violates.*directive/i.test(message.text()))
        cspViolations.push(message.text());
    });
    await page.route("http://plugins.test/**", async (route) => {
      const [name, generation, endpoint] = new URL(route.request().url()).pathname
        .slice(1)
        .split("/");
      if (generation !== "signed-generation" || !["ui", "rpc"].includes(endpoint)) {
        unexpectedRequests.push(route.request().url());
        return route.abort();
      }
      if (endpoint === "ui")
        return route.fulfill({
          body: html[name],
          contentType: "text/html",
          headers: {
            "Content-Security-Policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self' http://127.0.0.1:*; base-uri 'none'; form-action 'none'",
          },
        });
      const { method, input } = route.request().postDataJSON();
      let result = null;
      if (name === "system-info") {
        if (method === "info")
          result = {
            hostname: "test",
            platform: "win32",
            arch: "x64",
            uptimeMinutes: 1,
            memoryGiB: 8,
          };
        if (method === "read_note") {
          reads++;
          result = "saved note";
        }
        if (method === "save_note") {
          if (input === "cancel on hide") {
            cancelSaving.resolve();
            await releaseCancelledSave.promise;
          } else {
            saving.resolve(input);
            await saved.promise;
          }
          result = { saved: true };
        }
      } else if (name === "telemetry") {
        if (method === "send") sends++;
        result = {
          connected: true,
          sending: method === "send",
          lastError: sends && method === "status" ? "上传失败" : null,
          intervalSeconds: 300,
          lastSuccessAt: null,
          succeeded: 0,
          failed: sends ? 1 : 0,
        };
      } else if (name === "study-guard") result = { active: true, pending: [], last: "保护已启用" };
      else if (name === "password-pad") {
        passwordReads++;
        result = {
          id: "challenge",
          revision: 0,
          title: "验证",
          expiresAt: Date.now() + 10000,
          size: 6,
          cells: Array.from({ length: 36 }, (_, i) => (i === 35 ? "＃" : "A")),
        };
      }
      return route.fulfill({ json: { ok: true, result } });
    });
    await page.goto("http://plugins.test/system-info/signed-generation/ui");
    await expect(page.locator("#note")).toHaveValue("saved note");
    await page.locator("#note").fill("first draft");
    await page.locator("#save").click();
    assert.equal(await saving.promise, "first draft");
    await page.locator("#note").fill("new draft");
    saved.resolve();
    await expect(page.locator("#status")).toContainText("当前修改尚未保存");
    await page.locator("#refresh").click();
    await expect(page.locator("#note")).toHaveValue("new draft");
    await page.locator("#note").fill("cancel on hide");
    await page.locator("#save").click();
    await cancelSaving.promise;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await expect(page.locator("#app")).toBeEmpty();
    await expect.poll(() => page.evaluate(() => globalThis.cancelledSave)).toBe(true);
    releaseCancelledSave.resolve();
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
    });
    await expect(page.locator("#note")).toHaveValue("saved note");
    assert.equal(reads, 2);
    await page.goto("http://plugins.test/telemetry/signed-generation/ui");
    await page.locator("#send").click();
    await expect(page.locator("#status")).toContainText("上报失败");
    assert.equal(sends, 1);
    await page.locator("#report").click();
    const disclosure = page.getByRole("button", { name: "最近报告 · 原始数据" });
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#detail")).toBeVisible();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#detail")).toBeHidden();
    await disclosure.press("Enter");
    await expect(page.locator("#detail")).toBeVisible();
    await page.goto("http://plugins.test/study-guard/signed-generation/ui");
    await expect(page.locator('[data-browser="edge"]')).toBeEnabled();
    await expect(page.getByRole("heading", { name: "浏览器保护" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("壁纸");
    await page.goto("http://plugins.test/password-pad/signed-generation/ui#panel");
    const preview = page.locator("#cells button");
    await expect(preview).toHaveCount(36);
    assert((await preview.allTextContents()).every((value) => /^[A-Z0-9＃]$/.test(value)));
    await expect(preview.first()).toBeDisabled();
    await expect(page.locator("#cells")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#status")).toHaveText("密保盘预览");
    assert.equal(passwordReads, 0, "preview must never read or consume a live challenge");
    await page.goto("http://plugins.test/password-pad/signed-generation/ui#window");
    // Hash-only navigation reuses the Kit page and must remount the surface.
    const buttons = page.locator("#cells button");
    await expect(buttons.first()).toBeEnabled();
    assert.equal(await buttons.count(), 36);
    await buttons.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(buttons.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#input")).toHaveAttribute("aria-label", "已输入 1 位");
    await page.keyboard.press("Backspace");
    await expect(page.locator("#input")).toHaveAttribute("aria-label", "已输入 0 位");
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, [], "signed pages need no external assets or Kit server");
    assert.deepEqual(cspViolations, [], "inline output must run under the host CSP");
  },
);
