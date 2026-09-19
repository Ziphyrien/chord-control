import { access } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HostService } from "../../../sdk/index.ts";
import type { Json } from "../../../shared/protocol.ts";
import { WallpaperPolicy } from "./wallpaper.ts";
import {
  BROWSER_NAMES,
  BrowserGate,
  browserOf,
  identity,
  snapshot,
  type Browser,
} from "./browsers.ts";
export type { Browser } from "./browsers.ts";
export interface StudyPlatform {
  start(blocked: (browser: Browser) => void): Promise<void>;
  launch(browser: Browser): Promise<void>;
  dispose(): Promise<void>;
  measure(): Promise<{ checks: number; passed: number; owned: boolean; errors: string[] }>;
}
export function createPlatform(
  host: HostService,
  dataDir: string,
  log: (message: string) => void,
): StudyPlatform {
  const policy = new WallpaperPolicy(host, dataDir);
  const gate = new BrowserGate();
  let active = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<unknown> = Promise.resolve();
  const call = (operation: string, input: Json) =>
    host.native(operation, input, BACKGROUND_CONTEXT);
  const rows = async () => snapshot(await call("process.list", { names: BROWSER_NAMES }));
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = work.then(operation);
    work = next.catch(() => {});
    return next;
  }
  function schedule(blocked: (browser: Browser) => void): void {
    if (!active) return;
    timer = setTimeout(() => {
      void serialize(async () => {
        try {
          if (!active || !(await policy.owns())) return;
          const rejected = gate.blocked(await rows());
          const prompted = new Set<Browser>();
          for (const row of rejected) {
            if (!active || !(await policy.owns())) break;
            try {
              await call("process.terminate", { ...identity(row) });
              prompted.add(browserOf(row));
            } catch (error) {
              log(`浏览器拦截: ${String(error)}`);
            }
          }
          if (active) for (const browser of prompted) blocked(browser);
        } catch (error) {
          if (active) log(`浏览器监测: ${String(error)}`);
        } finally {
          schedule(blocked);
        }
      });
    }, 350);
  }
  async function executableFor(browser: Browser): Promise<string> {
    const remembered = gate.paths.get(browser);
    if (remembered) return remembered;
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
        return candidate;
      } catch {
        /* Probe the next standard installation directory. */
      }
    }
    throw new Error("未找到已安装的浏览器");
  }
  return {
    measure: () => serialize(() => policy.measure()),
    start(blocked) {
      return serialize(async () => {
        if (disposed) throw new Error("学习权限已停止");
        if (active) return;
        // Readiness is checked before any policy write.
        gate.initialize(await rows());
        await policy.apply();
        if (disposed) {
          await policy.restore();
          return;
        }
        active = true;
        schedule(blocked);
      });
    },
    launch(browser) {
      return serialize(async () => {
        if (!active || disposed || !(await policy.owns())) throw new Error("学习权限已停止");
        const executable = await executableFor(browser);
        if (!active || disposed) throw new Error("学习权限已停止");
        const spawned = identity(
          await call("process.spawn", { executable, args: ["--new-window"] }),
        );
        gate.authorize(spawned);
      });
    },
    async dispose() {
      disposed = true;
      active = false;
      clearTimeout(timer);
      await work;
      await policy.restore();
    },
  };
}
