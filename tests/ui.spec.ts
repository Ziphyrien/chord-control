import { test, expect, type Page } from "@playwright/test";
import type {
  ControllerCommand,
  ControllerSnapshot,
  Json,
  PluginSummary,
} from "../shared/protocol.ts";

const baseUrl = process.env.CHORD_UI_URL ?? "http://127.0.0.1:1420";
function plugin(id: string, name: string, patch: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id,
    name,
    description: "日常工作插件",
    version: "1.0.0",
    revision: "r1",
    status: "active",
    running: true,
    installed: true,
    enabled: true,
    hasUpdate: false,
    hasUi: true,
    source: "manual",
    sourceStatus: "available",
    permissions: [],
    updatedAt: "2026-01-01T00:00:00Z",
    icon: "",
    color: "",
    ...patch,
  };
}
function snapshot(): ControllerSnapshot {
  return {
    plugins: [
      plugin("base", "基础服务", {
        dependents: [
          { id: "notes", name: "便笺" },
          { id: "daily", name: "日程" },
        ],
      }),
      plugin("notes", "便笺"),
      plugin("daily", "日程"),
    ],
    activities: [],
    checkedAt: null,
    startedAt: "2026-01-01T00:00:00Z",
    controllerVersion: "test",
    settings: {
      checkIntervalMinutes: 30,
      autoUpdate: true,
      appCheckIntervalMinutes: 5,
      appAutoUpdate: true,
      catalogUrl: "",
      catalogPublicKey: "",
    },
    dataDir: "D:/Chord/data",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Reply = { result: Json; snapshot?: ControllerSnapshot; message?: string };
async function boot(
  page: Page,
  initial = snapshot(),
  handler?: (command: ControllerCommand) => Promise<Reply>,
) {
  const commands: ControllerCommand[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("controllerCommand", async (command: ControllerCommand) => {
    commands.push(command);
    if (handler) return handler(command);
    return { result: null, snapshot: initial };
  });
  await page.exposeFunction("desktopCommand", async (_command: string, enabled = false) => enabled);
  await page.goto(`${baseUrl}/tests/browser.html`);
  return { commands, errors };
}

test("adding a plugin opens its sandbox and activities can be filtered", async ({ page }) => {
  const value = snapshot();
  value.plugins = [];
  const h = await boot(page, value, async (command) => {
    if (command.type === "add_plugin") {
      value.plugins = [plugin("notes", "便笺")];
      value.activities = [
        {
          id: "installed",
          time: "2026-01-01T00:00:00Z",
          title: "插件已添加",
          detail: "便笺",
          tone: "success",
        },
      ];
    }
    if (command.type === "plugin_ui")
      return { result: { url: "https://plugin.test/notes", revision: "r1" } };
    return { result: null, snapshot: value };
  });
  await page.route("https://plugin.test/notes", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><title>便笺</title><body><label>便笺内容<textarea></textarea></label></body></html>',
    }),
  );
  await page.getByRole("button", { name: "添加插件", exact: true }).click();
  await page.getByLabel("插件地址", { exact: true }).fill("https://publisher.test/plugin.json");
  await page.getByLabel("发布者公钥", { exact: true }).fill("test-public-key");
  await page.getByRole("dialog").getByRole("button", { name: "安装", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(h.commands.find((command) => command.type === "add_plugin")).toMatchObject({
    manifestUrl: "https://publisher.test/plugin.json",
    publicKey: "test-public-key",
  });
  await page
    .getByRole("article", { name: "便笺", exact: true })
    .getByRole("button", { name: "打开", exact: true })
    .click();
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-downloads",
  );
  await page.frameLocator("iframe").getByLabel("便笺内容").fill("一条新的便笺");
  await page.getByRole("button", { name: "返回插件" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "活动", exact: true }).click();
  await expect(page.getByRole("heading", { name: "插件已添加", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "筛选活动" }).click();
  await page.getByRole("option", { name: "需要留意" }).click();
  await expect(page.getByRole("heading", { name: "没有需要留意的记录" })).toBeVisible();
  expect(h.errors).toEqual([]);
});

// Browser cases need an externally served frontend. No test body invokes a build.
// The root Playwright config must disable its dev server for artifact-only runs.
test("loading, offline, retry and business rejection remain distinct", async ({ page }) => {
  const initial = deferred<Reply>();
  let snapshots = 0;
  const h = await boot(page, snapshot(), async (command) => {
    if (command.type === "snapshot")
      return ++snapshots === 1 ? initial.promise : { result: null, snapshot: snapshot() };
    return { result: null, message: "发布者暂时不可用" };
  });
  await expect(page.getByText("正在连接控制器…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加插件", exact: true })).toBeDisabled();
  initial.resolve({ result: null, snapshot: snapshot() });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("发布者暂时不可用");
  await expect(page.getByRole("button", { name: "添加插件", exact: true })).toBeEnabled();
  await page.evaluate(() => window.testBridge.emit({ type: "disconnected", message: "连接中断" }));
  await expect(page.getByText("连接已断开", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重新连接" }).click();
  await expect(page.getByRole("button", { name: "检查更新", exact: true })).toBeEnabled();
  expect(h.errors).toEqual([]);
});

test("pause and remove confirm exact downstream names and IDs", async ({ page }) => {
  const value = snapshot();
  const h = await boot(page, value, async (command) => {
    if (command.type === "set_enabled")
      value.plugins = value.plugins.map((item) => ({
        ...item,
        enabled: false,
        running: false,
        status: "paused",
        dependents: [],
      }));
    if (command.type === "remove_plugin")
      value.plugins = value.plugins.filter((item) => item.id !== command.pluginId);
    return { result: null, snapshot: value };
  });
  const base = page.getByRole("article", { name: "基础服务", exact: true });
  await base.getByRole("button", { name: "暂停", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("listitem")).toHaveText(["便笺", "日程"]);
  await page.keyboard.press("Escape");
  expect(h.commands.some((item) => item.type === "set_enabled")).toBe(false);
  await base.getByRole("button", { name: "暂停", exact: true }).click();
  await dialog.getByRole("button", { name: "确认暂停" }).click();
  await expect(dialog).toHaveCount(0);
  expect(h.commands.find((item) => item.type === "set_enabled")).toMatchObject({
    pluginId: "base",
    enabled: false,
    affectedPluginIds: ["notes", "daily"],
  });
  await base.getByRole("button", { name: "移除", exact: true }).click();
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect(base).toHaveCount(0);
  expect(h.commands.find((item) => item.type === "remove_plugin")).toMatchObject({
    pluginId: "base",
    affectedPluginIds: [],
  });
  await expect(page.getByRole("article", { name: "便笺", exact: true })).toContainText("已暂停");
  expect(h.errors).toEqual([]);
});

test("changed dependency graph requires a fresh explicit confirmation", async ({ page }) => {
  const value = snapshot();
  let attempts = 0;
  await boot(page, value, async (command) => {
    if (command.type === "set_enabled" && ++attempts === 1) {
      value.plugins[0].dependents = [{ id: "notes", name: "便笺" }];
      return { result: null, message: "依赖关系已变化" };
    }
    return { result: null, snapshot: value };
  });
  await page
    .getByRole("article", { name: "基础服务", exact: true })
    .getByRole("button", { name: "暂停", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认暂停" }).click();
  await expect(dialog.getByRole("alert")).toContainText("依赖关系已变化");
  await expect(dialog.getByRole("listitem")).toHaveText(["便笺"]);
  expect(attempts).toBe(1);
  await dialog.getByRole("button", { name: "确认暂停" }).click();
  await expect(dialog).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("late panel response cannot reopen a closed view or replace a new connection", async ({
  page,
}) => {
  const requests: ReturnType<typeof deferred<Reply>>[] = [];
  await boot(page, snapshot(), async (command) => {
    if (command.type === "plugin_ui") {
      const request = deferred<Reply>();
      requests.push(request);
      return request.promise;
    }
    return { result: null, snapshot: snapshot() };
  });
  const open = () =>
    page
      .getByRole("article", { name: "基础服务", exact: true })
      .getByRole("button", { name: "打开", exact: true })
      .click();
  await open();
  await expect(page.getByText("正在打开插件…", { exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole("button", { name: "返回插件" }).click();
  requests[0].resolve({ result: { url: "https://example.invalid/old", revision: "r1" } });
  await expect(page.locator("iframe")).toHaveCount(0);
  await open();
  await expect.poll(() => requests.length).toBe(2);
  await page.evaluate(() => window.testBridge.emit({ type: "disconnected", message: "连接中断" }));
  await page.getByRole("button", { name: "重新连接" }).click();
  requests[1].resolve({ result: { url: "https://example.invalid/older", revision: "r1" } });
  await expect(page.getByRole("heading", { name: "插件", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.evaluate(() => window.testBridge.subscriptions())).toBe(1);
  await page.evaluate(() => window.testBridge.dispose());
  expect(await page.evaluate(() => window.testBridge.subscriptions())).toBe(0);
});

test("settings draft survives snapshots and independent desktop operations", async ({ page }) => {
  const saving = deferred<Reply>();
  const value = snapshot();
  const h = await boot(page, value, async (command) => {
    if (command.type === "set_settings") {
      value.settings = command.settings;
      return saving.promise;
    }
    return { result: null, snapshot: value };
  });
  await page.getByRole("navigation").getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("检查间隔（分钟）", { exact: true }).fill("15");
  await page.getByLabel("主程序检查间隔（分钟）", { exact: true }).fill("7");
  await page.getByRole("checkbox", { name: "自动安装主程序更新" }).uncheck();
  await page.evaluate(
    (value) => window.testBridge.emit({ type: "snapshot", snapshot: value }),
    value,
  );
  await expect(page.getByLabel("检查间隔（分钟）", { exact: true })).toHaveValue("15");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("switch", { name: "登录时自动启动" }).check();
  await expect(page.getByRole("switch")).toBeChecked();
  await expect(page.getByRole("button", { name: "保存中…", exact: true })).toBeDisabled();
  saving.resolve({ result: null, snapshot: value });
  await expect(page.getByRole("status")).toHaveText("设置已保存");
  const saved = h.commands.filter((item) => item.type === "set_settings");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    settings: {
      checkIntervalMinutes: 15,
      autoUpdate: true,
      appCheckIntervalMinutes: 7,
      appAutoUpdate: false,
    },
  });
});

test("search, source states, blocked reason and narrow layout remain readable", async ({
  page,
}) => {
  const value = snapshot();
  value.plugins[0] = plugin("base", "一个很长的插件名称用于检查窄屏布局", {
    status: "blocked",
    running: false,
    enabled: false,
    sourceStatus: "missing",
    blockedReason: "请先启动基础服务",
  });
  const h = await boot(page, value);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("来源已移除", { exact: true })).toBeVisible();
  await expect(page.getByText("请先启动基础服务", { exact: true })).toBeVisible();
  await page.getByLabel("搜索插件").fill("便笺");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByLabel("搜索插件").fill("不存在");
  await expect(page.getByRole("heading", { name: "没有匹配的插件" })).toBeVisible();
  await page.getByRole("button", { name: "清除搜索" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/frontend-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "test-results/frontend-desktop.png", fullPage: true });
  expect(h.errors).toEqual([]);
});

test("cancel buttons and Escape discard add form data without issuing commands", async ({
  page,
}) => {
  const h = await boot(page);
  const add = page.getByRole("button", { name: "添加插件", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog");
  await page.getByLabel("插件地址", { exact: true }).fill("https://publisher.test/plugin.json");
  await page.getByLabel("发布者公钥", { exact: true }).fill("test-public-key");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(h.commands.some((command) => command.type === "add_plugin")).toBe(false);
  await add.click();
  await expect(page.getByLabel("插件地址", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("发布者公钥", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  expect(h.commands.some((command) => command.type === "add_plugin")).toBe(false);
  expect(h.errors).toEqual([]);
});

test("native invoke rejection stays online and malformed events leave the last valid view intact", async ({
  page,
}) => {
  const h = await boot(page, snapshot(), async (command) => {
    if (command.type === "check_updates") throw new Error("控制中心尚未解锁");
    return { result: null, snapshot: snapshot() };
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("控制中心尚未解锁");
  await expect(page.locator(".sidebar .connection")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加插件", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "关闭错误提示" }).click();
  await page.evaluate(() =>
    window.testBridge.emitRaw('{"type":"snapshot","snapshot":{"plugins":"bad"}}'),
  );
  await expect(page.getByRole("alert")).toContainText("收到无法识别的数据");
  await expect(page.getByRole("article")).toHaveCount(3);
  expect(h.errors).toEqual([]);
});

test("a snapshot changing the open confirmation prevents submission of the stale list", async ({
  page,
}) => {
  const value = snapshot();
  const h = await boot(page, value);
  const trigger = page
    .getByRole("article", { name: "基础服务", exact: true })
    .getByRole("button", { name: "暂停", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("listitem")).toHaveText(["便笺", "日程"]);
  value.plugins[0].dependents = [{ id: "notes", name: "便笺" }];
  await page.evaluate(
    (value) => window.testBridge.emit({ type: "snapshot", snapshot: value }),
    value,
  );
  await dialog.getByRole("button", { name: "确认暂停" }).click();
  await expect(dialog.getByRole("alert")).toContainText("重新确认名单");
  await expect(dialog.getByRole("listitem")).toHaveText(["便笺"]);
  expect(h.commands.filter((command) => command.type === "set_enabled")).toHaveLength(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(h.errors).toEqual([]);
});

test("removing an enabled provider confirms all downstream plugins and preserves their rows", async ({
  page,
}) => {
  const value = snapshot();
  const h = await boot(page, value, async (command) => {
    if (command.type === "remove_plugin") {
      if (
        command.pluginId !== "base" ||
        JSON.stringify(command.affectedPluginIds) !== JSON.stringify(["notes", "daily"])
      )
        return { result: null, message: "需要完整确认名单" };
      value.plugins = value.plugins
        .filter((item) => item.id !== command.pluginId)
        .map((item) => ({
          ...item,
          running: false,
          enabled: false,
          status: "paused",
          dependents: [],
        }));
    }
    return { result: null, snapshot: value };
  });
  await page
    .getByRole("article", { name: "基础服务", exact: true })
    .getByRole("button", { name: "移除", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("list", { name: "一并暂停的插件" }).getByRole("listitem"),
  ).toHaveText(["便笺", "日程"]);
  await expect(dialog).toContainText("安装和数据会保留");
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(2);
  for (const name of ["便笺", "日程"]) {
    const row = page.getByRole("article", { name, exact: true });
    await expect(row).toContainText("已暂停");
    await expect(row).toContainText("v1.0.0");
  }
  expect(h.commands.filter((command) => command.type === "remove_plugin")).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

test("settings undo is not a submit and failed explicit enable does not start prerequisites", async ({
  page,
}) => {
  const value = snapshot();
  value.plugins[1] = { ...value.plugins[1], enabled: false, running: false, status: "paused" };
  const h = await boot(page, value, async (command) =>
    command.type === "set_enabled"
      ? { result: null, message: "请先启用基础服务" }
      : { result: null, snapshot: value },
  );
  await page
    .getByRole("article", { name: "便笺", exact: true })
    .getByRole("button", { name: "启动", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("请先启用基础服务");
  const enable = h.commands.filter((command) => command.type === "set_enabled");
  expect(enable).toHaveLength(1);
  expect(enable[0]).toMatchObject({ pluginId: "notes", enabled: true });
  await page.getByRole("navigation").getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("检查间隔（分钟）", { exact: true }).fill("17");
  await page.getByRole("button", { name: "撤销更改" }).click();
  await expect(page.getByLabel("检查间隔（分钟）", { exact: true })).toHaveValue("30");
  expect(h.commands.filter((command) => command.type === "set_settings")).toHaveLength(0);
  expect(h.errors).toEqual([]);
});
