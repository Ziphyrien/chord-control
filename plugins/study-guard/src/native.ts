import { access } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HostService } from "../../../sdk/index.ts";
import type { Json } from "../../../shared/protocol.ts";
import { WallpaperPolicy } from "./wallpaper.ts";
export type Browser = "edge" | "chrome";
export interface StudyPlatform {
  start(blocked: (browser: Browser) => void): Promise<void>;
  launch(browser: Browser): Promise<void>;
  dispose(): Promise<void>;
}
type Process = {
  pid: number;
  parentPid: number;
  name: string;
  executable: string;
  createdAt: string;
};
const key = (process: Process) => `${process.pid}:${process.createdAt}`;
const browserOf = (process: Process): Browser =>
  process.name.toLowerCase() === "msedge.exe" ? "edge" : "chrome";
export function createPlatform(
  host: HostService,
  dataDir: string,
  bundleDir: string,
  log: (message: string) => void,
): StudyPlatform {
  const policy = new WallpaperPolicy(host, dataDir, bundleDir),
    paths = new Map<Browser, string>(),
    allow = new Map<Browser, number>();
  let active = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    polling: Promise<void> | undefined;
  let seen = new Set<string>();
  const call = (operation: string, input: Json) =>
    host.native(operation, input, BACKGROUND_CONTEXT);
  async function roots(): Promise<Process[]> {
    const rows = (await call("process.list", { names: ["msedge.exe", "chrome.exe"] })) as Process[];
    const ids = new Set(rows.map((row) => row.pid));
    return rows.filter((row) => !ids.has(row.parentPid));
  }
  async function poll(blocked: (browser: Browser) => void): Promise<void> {
    try {
      if (!active || !(await policy.owns())) return;
      const rows = await roots();
      for (const row of rows) {
        const browser = browserOf(row);
        paths.set(browser, row.executable);
        if (!active || seen.has(key(row)) || (allow.get(browser) ?? 0) > Date.now()) continue;
        await call("process.terminate", {
          pid: row.pid,
          createdAt: row.createdAt,
          executable: row.executable,
        });
        blocked(browser);
      }
      seen = new Set(rows.map(key));
    } catch (error) {
      if (active) log(`浏览器监测: ${String(error)}`);
    } finally {
      if (active)
        timer = setTimeout(() => {
          polling = poll(blocked);
        }, 350);
    }
  }
  return {
    async start(blocked) {
      // Native snapshot succeeds before policies change; no shell startup or WMI readiness wait.
      const rows = await roots();
      seen = new Set(rows.map(key));
      for (const row of rows) paths.set(browserOf(row), row.executable);
      await policy.apply();
      active = true;
      timer = setTimeout(() => {
        polling = poll(blocked);
      }, 350);
    },
    async launch(browser) {
      if (!active) throw new Error("学习权限已停止");
      let executable = paths.get(browser);
      if (!executable) {
        const suffix =
          browser === "edge"
            ? "Microsoft/Edge/Application/msedge.exe"
            : "Google/Chrome/Application/chrome.exe";
        for (const folder of [
          process.env["ProgramFiles(x86)"],
          process.env.ProgramFiles,
          process.env.LOCALAPPDATA,
        ]) {
          if (!folder) continue;
          const candidate = join(folder, suffix);
          try {
            await access(candidate);
            executable = candidate;
            break;
          } catch {
            /* Try next installation location. */
          }
        }
      }
      if (!executable) throw new Error("未找到已安装的浏览器");
      allow.set(browser, Date.now() + 3000);
      try {
        await call("process.spawn", { executable, args: ["--new-window"] });
      } catch (error) {
        allow.delete(browser);
        throw error;
      }
    },
    async dispose() {
      active = false;
      clearTimeout(timer);
      await polling;
      await policy.restore();
    },
  };
}
