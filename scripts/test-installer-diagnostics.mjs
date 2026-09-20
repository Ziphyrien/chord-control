import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "This smoke test executes a Windows NSIS fixture.");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// Tauri downloads this compiler during the preceding Windows installer build.
const makeNsis =
  process.argv[2] ??
  [
    path.join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/Bin/makensis.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "", "NSIS/makensis.exe"),
  ].find(existsSync) ??
  "makensis.exe";
const header = path.join(repoRoot, "src-tauri/windows/diagnostics.nsh");
const template = readFileSync(path.join(repoRoot, "src-tauri/windows/installer.nsi"), "utf8");
// Exercise the real installer callbacks as well as the production logger.
const callbacks = ["onInstFailed", "onInstSuccess"]
  .map((name) => {
    const match = template.match(
      new RegExp(`^Function \\.${name}\\r?\\n[\\s\\S]*?^FunctionEnd`, "m"),
    );
    assert.ok(match, `Missing installer callback .${name}`);
    return match[0];
  })
  .join("\n");
const tempRoot = mkdtempSync(path.join(tmpdir(), "chord-installer-diagnostics-"));
const logRoot = path.join(tempRoot, "logs");
const log = path.join(logRoot, "installer.log");
const previous = path.join(logRoot, "installer.previous.log");
const exe = path.join(tempRoot, "fixture.exe");

function invokeFixture(mode, expectedExit) {
  const result = spawnSync(exe, ["/S", "/private-command-line-sentinel"], {
    env: { ...process.env, CHORD_INSTALLER_TEST_MODE: mode },
    timeout: 20_000,
    windowsHide: true,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  if (result.status !== expectedExit && existsSync(log) && statSync(log).isFile()) {
    console.error(readLog(log));
  }
  assert.equal(result.status, expectedExit, `NSIS fixture ${mode} (90=state corruption)`);
}
function readLog(file) {
  const bytes = readFileSync(file);
  assert.ok(bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe, "Missing UTF-16LE BOM");
  return bytes.subarray(2).toString("utf16le");
}
function writeUnicode(file, text) {
  writeFileSync(file, "\ufeff" + text, "utf16le");
}
function resetLogs() {
  rmSync(logRoot, { recursive: true, force: true });
}

try {
  const registers = Array.from({ length: 20 }, (_, i) => (i < 10 ? `$${i}` : `$R${i - 10}`));
  const setRegisters = registers
    .map((reg) => `  StrCpy ${reg} "sentinel-${reg.slice(1)}"`)
    .join("\n");
  const checkRegisters = registers
    .map((reg) =>
      [
        "  ${If} " + reg + ' != "sentinel-' + reg.slice(1) + '"',
        '    !insertmacro InstallerLog "register_changed" "' + reg.slice(1) + '" "' + reg + '"',
        "    Goto state_corrupt",
        "  ${EndIf}",
      ].join("\n"),
    )
    .join("\n");
  // This fixture only includes diagnostics and callbacks. It never includes install
  // sections or startup hooks, and never writes registry keys or real app files.
  const fixture = String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Installer diagnostics fixture"
OutFile "@EXE@"
!define INSTALLER_DIAGNOSTIC_VERSION "fixture-0.4.7"
!define INSTALLER_DIAGNOSTIC_ROOT "$EXEDIR\logs"
!include "@HEADER@"
Var TestMode
Function .onInit
  StrCpy $INSTDIR "$EXEDIR\安装目录"
  ReadEnvStr $TestMode "CHORD_INSTALLER_TEST_MODE"
  !insertmacro InstallerLog "init" "entered" "$EXEPATH"
FunctionEnd
@CALLBACKS@
Section
@SET_REGISTERS@
  Push "stack-sentinel"
  SetErrorLevel 37
  ClearErrors
  !insertmacro InstallerLog "probe_clear" "$0" "$1"
  IfErrors state_corrupt
@CHECK_REGISTERS@
  SetErrors
  !insertmacro InstallerLog "probe_set" "$R0" "$R1"
  IfErrors +2
    Goto state_corrupt
@CHECK_REGISTERS@
  ; IfErrors consumes the flag, so set it again before testing the result macro.
  SetErrors
  !insertmacro InstallerLogResult "result_set" "$INSTDIR"
  IfErrors +2
    Goto state_corrupt
@CHECK_REGISTERS@
  ClearErrors
  !insertmacro InstallerLogResult "result_clear" "$INSTDIR"
  IfErrors state_corrupt
@CHECK_REGISTERS@
  GetErrorLevel $0
  StrCmp $0 37 +2
    Goto state_corrupt
  Pop $0
  StrCmp $0 "stack-sentinel" +2
    Goto state_corrupt
  StrCmp $TestMode "failure" 0 done
  SetErrorLevel 23
  Abort "intentional fixture failure"
  done:
  SetErrorLevel 0
  Goto end
  state_corrupt:
  SetErrorLevel 90
  Abort "logger corrupted caller state"
  end:
SectionEnd
`;
  const source = fixture
    .replace("@EXE@", () => exe)
    .replace("@HEADER@", () => header)
    .replace("@CALLBACKS@", () => callbacks)
    .replace("@SET_REGISTERS@", () => setRegisters)
    .replaceAll("@CHECK_REGISTERS@", () => checkRegisters);
  const nsi = path.join(tempRoot, "fixture.nsi");
  writeFileSync(nsi, "\ufeff" + source, "utf8");
  const compiled = spawnSync(makeNsis, ["/V2", nsi], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.ifError(compiled.error);
  assert.equal(
    compiled.status,
    0,
    `NSIS fixture compilation failed:\n${compiled.stdout}\n${compiled.stderr}`,
  );

  invokeFixture("success", 0);
  let text = readLog(log);
  for (const event of [
    "init",
    "probe_clear",
    "probe_set",
    "result_set",
    "result_clear",
    "installer_succeeded",
  ]) {
    assert.ok(text.includes(`event=${event} `), `Missing ${event} event`);
  }
  assert.ok(
    text.includes("event=probe_clear version=fixture-0.4.7 path=sentinel-1 status=sentinel-0"),
    "Numeric register arguments were changed",
  );
  assert.ok(
    text.includes("event=probe_set version=fixture-0.4.7 path=sentinel-R1 status=sentinel-R0"),
    "R register arguments were changed",
  );
  assert.ok(text.includes("安装目录 status=ok"), "Unicode path was not retained");
  assert.ok(text.includes("status=exitcode=0"), "Success callback exit code missing");
  for (const line of text.split("\r\n").filter(Boolean)) {
    assert.match(
      line,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} pid=\d+ event=\S+ version=fixture-0\.4\.7 path=.+ status=.+$/,
      "Malformed record",
    );
  }
  assert.ok(!text.includes("private-command-line-sentinel"), "Command line leaked into log");

  invokeFixture("failure", 23);
  text = readLog(log);
  assert.ok(
    text.includes("event=installer_failed ") && text.includes("status=exitcode=23"),
    "Failure callback/exit code missing",
  );
  assert.ok(
    text.includes("event=installer_succeeded "),
    "Second invocation erased the earlier attempt",
  );

  // Cross the rotation boundary twice. The older previous file must be replaced.
  for (const iteration of [1, 2]) {
    const seed = `rotation-${iteration}:` + "x".repeat(258050);
    writeUnicode(log, seed);
    invokeFixture("success", 0);
    assert.equal(readLog(previous), seed, "Rotation did not preserve the preceding log");
    assert.ok(
      readLog(log).includes("event=installer_succeeded "),
      "Rotated log missing current attempt",
    );
    const sizes = [statSync(log).size, statSync(previous).size];
    assert.ok(
      sizes.every((size) => size <= 512 * 1024) && sizes[0] + sizes[1] <= 1024 * 1024,
      "Log retention exceeded its bound",
    );
  }

  // All failures must preserve both error states, all registers and exit codes.
  resetLogs();
  writeFileSync(logRoot, "block-directory-creation");
  invokeFixture("success", 0);
  invokeFixture("failure", 23);
  assert.equal(
    readFileSync(logRoot, "utf8"),
    "block-directory-creation",
    "Logging overwrote an obstructing file",
  );
  resetLogs();
  mkdirSync(log, { recursive: true });
  invokeFixture("success", 0);
  invokeFixture("failure", 23);
  resetLogs();
  mkdirSync(previous, { recursive: true });
  writeUnicode(log, "x".repeat(258050));
  const before = statSync(log).size;
  invokeFixture("success", 0);
  assert.equal(statSync(log).size, before, "Failed rotation appended past the bound");

  console.log(
    "PASS: NSIS executable preserved errors, 20 registers, stack and exit codes; callbacks, Unicode records, append, rotation and filesystem failure paths verified.",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
