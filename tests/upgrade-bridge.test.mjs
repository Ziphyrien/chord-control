import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  executableVersion,
  installedApplication,
} from "../plugins/upgrade-bridge/src/installation.ts";
import { launch } from "../plugins/upgrade-bridge/src/upgrade.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

// Minimal PE32+ with RT_VERSION -> name 1 -> language 1033 and VS_FIXEDFILEINFO.
function executableFixture() {
  const file = Buffer.alloc(1024);
  file.write("MZ");
  file.writeUInt32LE(0x80, 0x3c);
  file.write("PE\0\0", 0x80);
  file.writeUInt16LE(0x8664, 0x84);
  file.writeUInt16LE(1, 0x86);
  file.writeUInt16LE(240, 0x94);
  file.writeUInt16LE(0x20b, 0x98);
  file.writeUInt32LE(0x1000, 0x118);
  file.writeUInt32LE(512, 0x11c);
  file.write(".rsrc", 0x188);
  file.writeUInt32LE(0x1000, 0x194);
  file.writeUInt32LE(512, 0x198);
  file.writeUInt32LE(512, 0x19c);
  const r = file.subarray(512);
  for (const [offset, id, next] of [
    [0, 16, 0x80000018],
    [24, 1, 0x80000030],
    [48, 1033, 72],
  ]) {
    r.writeUInt16LE(1, offset + 14);
    r.writeUInt32LE(id, offset + 16);
    r.writeUInt32LE(next, offset + 20);
  }
  r.writeUInt32LE(0x1000 + 88, 72);
  r.writeUInt32LE(92, 76);
  const info = r.subarray(88);
  info.writeUInt16LE(92);
  info.writeUInt16LE(52, 2);
  info.write("VS_VERSION_INFO\0", 6, "utf16le");
  info.writeUInt32LE(0xfeef04bd, 40);
  info.writeUInt32LE(0x10000, 44);
  info.writeUInt32LE(3, 48);
  info.writeUInt32LE(2 << 16, 52);
  info.writeUInt32LE(1, 76);
  return file;
}
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "Chord 安装 路径-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("installation is detected from the running sidecar and sibling host without registry values", async (t) => {
  const root = await directory(t),
    exe = join(root, "plugin-controller.exe");
  await writeFile(exe, "fixture");
  await writeFile(join(root, "chord-control.exe"), executableFixture());
  const result = await installedApplication(exe, new AbortController().signal);
  assert.equal(result.directory, await realpath(root));
  assert.equal(result.version, "0.3.2");
});

test("missing host, wrong executable and malformed version resources fail before installation", async (t) => {
  const root = await directory(t),
    signal = new AbortController().signal;
  const exe = join(root, "plugin-controller.exe");
  await writeFile(exe, "fixture");
  await assert.rejects(installedApplication(exe, signal), /主程序文件/);
  await assert.rejects(installedApplication(join(root, "node.exe"), signal), /已安装/);
  const file = executableFixture();
  file.writeUInt32LE(0x7fffffff, 512 + 72);
  for (const invalid of [Buffer.from("MZinvalid"), executableFixture().subarray(0, 700), file])
    assert.throws(() => executableVersion(invalid), /Windows 版本信息/);
  const aborted = AbortSignal.abort();
  await assert.rejects(installedApplication(exe, aborted), /abort/i);
});

test("silent NSIS launch preserves the final unquoted directory tail and detaches", async (t) => {
  const root = await directory(t),
    installer = join(root, "新安装 程序.exe");
  const installation = await realpath(root);
  await writeFile(join(root, "plugin-controller.exe"), "fixture");
  const original = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "execPath", {
    ...original,
    value: join(root, "plugin-controller.exe"),
  });
  t.onTestFinished(() => {
    Object.defineProperty(process, "execPath", original);
    vi.mocked(spawn).mockReset();
  });
  const child = new EventEmitter();
  child.unref = vi.fn();
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const failed = vi.fn();
  await launch(installer, installation, new AbortController().signal, failed);
  const [file, args, options] = vi.mocked(spawn).mock.calls[0];
  assert.equal(file, installer);
  assert.deepEqual(args, ["/S", "/UPDATE", `/D=${installation}`]);
  assert.equal(options.argv0, `"${installer}"`);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(child.unref.mock.calls.length, 1);
  child.emit("exit", 1);
  assert.equal(failed.mock.calls.length, 1);
  await assert.rejects(
    launch(installer, dirname(root), new AbortController().signal, failed),
    /目录不一致/,
  );
  await assert.rejects(launch(installer, installation, AbortSignal.abort(), failed), /abort/i);
  assert.equal(vi.mocked(spawn).mock.calls.length, 1);
});
