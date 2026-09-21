import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { collectWindows } from "../plugins/telemetry/src/windows.ts";

const launch = vi.hoisted(() => ({ run: undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => launch.run(...args) };
});

for (const failure of ["cancellation", "stdin failure"]) {
  test(`collector retains ownership until the child closes after ${failure}`, async (t) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    t.onTestFinished(() => {
      launch.run = undefined;
      vi.unstubAllGlobals();
    });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    const controller = new AbortController();
    const code = failure === "cancellation" ? "ABORT_ERR" : "EPIPE";
    launch.run = (_file, _args, options, callback) => {
      options.signal.addEventListener(
        "abort",
        () => {
          callback(Object.assign(new Error("Collector cancelled"), { code }), "");
        },
        { once: true },
      );
      return child;
    };
    let settled = false;
    const collecting = collectWindows("test-bundle", {}, controller.signal).then((result) => {
      settled = true;
      return result;
    });
    try {
      if (failure === "cancellation") controller.abort();
      else child.stdin.emit("error", Object.assign(new Error("Input pipe closed"), { code }));
      await setImmediate();
      assert.equal(
        settled,
        false,
        "The runtime must not remove the EXE while its child is closing",
      );
    } finally {
      child.emit("close", 1, null);
      child.stdin.destroy();
      const result = await collecting;
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
    }
  });
}
