import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export type Browser = "edge" | "chrome";
export interface StudyPlatform {
  start(blocked: (browser: Browser) => void): Promise<void>;
  launch(browser: Browser): Promise<void>;
  dispose(): Promise<void>;
}
function powershell(script: string): ChildProcessWithoutNullStreams {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
}
async function run(script: string, input: object): Promise<void> {
  const child = powershell(script);
  let errors = "";
  child.stderr.on("data", (bytes) => {
    errors = (errors + String(bytes)).slice(-4000);
  });
  child.stdout.resume();
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(errors || `Windows 操作失败 (${code})`)),
      );
      child.stdin.on("error", reject);
      child.stdin.end(JSON.stringify(input));
    });
  } finally {
    clearTimeout(timer);
  }
}
export function createPlatform(
  dataDir: string,
  bundleDir: string,
  log: (message: string) => void,
): StudyPlatform {
  const owner = randomUUID(),
    policy = join(bundleDir, "assets/wallpaper-policy.ps1"),
    wallpaper = join(dataDir, "study-wallpaper.png");
  let monitor: ChildProcessWithoutNullStreams | undefined,
    active = false;
  const simulated = process.env.CHORD_CONTROL_NATIVE_TEST === "1";
  const record = (action: string) =>
    appendFile(join(dataDir, "native-test.jsonl"), JSON.stringify({ action }) + "\n");
  return {
    async start(blocked) {
      if (simulated) {
        active = true;
        await record("wallpaper:apply");
        return;
      }
      if (process.platform !== "win32") throw new Error("学习权限仅支持 Windows");
      await copyFile(join(bundleDir, "assets/study-wallpaper.png"), wallpaper);
      await run(policy, { action: "apply", dataDir, owner, wallpaper });
      active = true;
      monitor = powershell(join(bundleDir, "assets/browser-monitor.ps1"));
      const child = monitor;
      const lines = createInterface({ input: child.stdout });
      child.stderr.on("data", (bytes) => log(String(bytes).slice(0, 2000)));
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("浏览器监测启动超时")), 15000);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            if (active) log(`浏览器监测已停止 (${code})`);
            reject(new Error("浏览器监测已停止"));
          });
          lines.on("line", (line) => {
            try {
              const event = JSON.parse(line.replace(/^\uFEFF/, ""));
              if (event.type === "ready") {
                clearTimeout(timer);
                resolve();
              } else if (
                event.type === "blocked" &&
                (event.browser === "edge" || event.browser === "chrome")
              )
                blocked(event.browser);
              else if (event.type === "error") log(String(event.message));
            } catch {
              log("浏览器监测返回无效数据");
            }
          });
        });
      } catch (error) {
        child.kill();
        await run(policy, { action: "restore", dataDir, owner });
        active = false;
        throw error;
      }
    },
    async launch(browser) {
      if (!active) throw new Error("学习权限已停止");
      if (simulated) {
        await record(`launch:${browser}`);
        return;
      }
      if (!monitor || monitor.exitCode !== null) throw new Error("浏览器监测未运行");
      monitor.stdin.write(JSON.stringify({ type: "launch", browser }) + "\n");
    },
    async dispose() {
      if (!active) return;
      active = false;
      if (simulated) {
        await record("wallpaper:restore");
        return;
      }
      monitor?.stdin.end();
      if (monitor && monitor.exitCode === null) {
        const child = monitor;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill();
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await run(policy, { action: "restore", dataDir, owner });
    },
  };
}
