import { test, expect } from "@playwright/test";
import { createHarness, pluginId } from "./helpers.mjs";

test("disconnected app keeps actions disabled and shows only useful connection state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:1420");
  await expect(page.getByText("无法连接控制器", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "添加插件" })).toBeDisabled();
  await expect(page.getByRole("navigation").getByRole("button")).toHaveText([
    "插件",
    "记录",
    "设置",
  ]);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("检查间隔（分钟）")).toHaveValue("30");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("install, sandbox UI, saved settings and pause work through the real controller", async ({
  page,
}) => {
  const h = await createHarness();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await h.buildExample();
    await h.start();
    await page.exposeFunction("controllerCommand", async (command) => {
      try {
        return { result: await h.command(command), snapshot: h.snapshot };
      } catch (error) {
        return { result: null, snapshot: h.snapshot, message: String(error) };
      }
    });
    await page.goto("http://127.0.0.1:1420/tests/browser.html");
    await page.getByRole("button", { name: "添加插件", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "添加插件", exact: true }).click();
    await page.getByLabel("插件地址", { exact: true }).fill(`${h.baseUrl}/manifest.json`);
    await page.getByLabel("发布者公钥", { exact: true }).fill(h.publicPem);
    await page.getByRole("button", { name: "安装", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("运行中", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/plugins.png", fullPage: true });
    await page.getByRole("button", { name: "打开", exact: true }).click();
    const frame = page.frameLocator('iframe[title="系统信息与便笺"]');
    await expect(frame.locator("#info")).toContainText("计算机名称");
    await expect(frame.locator("#info")).toContainText("内存");
    await frame.getByLabel("本机便笺").fill("saved from the plugin page");
    await frame.getByRole("button", { name: "保存便笺" }).click();
    await expect(frame.locator("#status")).toHaveText("已保存");
    expect(
      await h.command({ type: "plugin_call", pluginId, method: "read_note", input: null }),
    ).toBe("saved from the plugin page");
    await page.getByRole("button", { name: "返回插件" }).click();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
    expect(h.snapshot.plugins[0].running).toBe(false);
    await page.getByRole("button", { name: "启动", exact: true }).click();
    await expect(page.getByText("运行中", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("检查间隔（分钟）").fill("15");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("设置已保存");
    expect(h.snapshot.settings.checkIntervalMinutes).toBe(15);
    await page.getByRole("button", { name: "插件", exact: true }).click();
    await page.getByLabel("系统信息与便笺的更多操作").click();
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await expect(page.getByText("尚未添加插件", { exact: true })).toBeVisible();
    expect(h.snapshot.plugins).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await h.close();
  }
});
