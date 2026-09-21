# chord-observer protocol 1

Standalone, read-only Windows x64 MSVC console executable owned by the telemetry plugin.
No host integration, network client, external commands, policy writes, privilege adjustment,
thread impersonation, registry creation or registry value writes. The parent launches with
`windowsHide: true`, sends one UTF-8 JSON document, closes stdin, caps the entire child
lifetime at **10 seconds**, and caps captured stdout at **65536 bytes**. The helper also
bounds input to **32768 bytes** and output (including its newline) to **65536 bytes**.
It waits for stdin EOF; the parent timeout is required, including for blocked native APIs.
Stdout contains exactly one compact JSON document plus a newline; no diagnostic logging.
Exit 0 means the envelope was handled, even when individual probes failed. Exit 2 is an
invalid input envelope; exit 1 means stdout could not be written. Always inspect JSON outcomes.

## Request

```json
{
  "format": 1,
  "processes": [{ "role": "desktop", "pid": 1234, "createdAt": "133900000000000000" }],
  "registry": [
    {
      "eventId": "event-1",
      "pid": 1234,
      "createdAt": "133900000000000000",
      "path": "Software\\Vendor\\App",
      "name": "Setting",
      "desiredAccess": 2,
      "allowParent": true
    }
  ]
}
```

Both arrays are required; maximum 3 processes and 8 registry probes. Unknown top-level
fields, unsupported format, invalid array types, oversized input, or excessive counts
fail the envelope. Each array entry is parsed independently: malformed entries and unknown
entry fields fail only that entry. There is no generic probe/command dispatch or CLI mode.
Input must be JSON without BOM or trailing non-whitespace data.

- `role`: nonempty string, at most 64 UTF-8 bytes, no control characters.
- `eventId`: nonempty string, at most 128 UTF-8 bytes, no control characters.
- `pid`: nonzero u32. No special self/parent sentinel.
- `createdAt`: decimal nonzero u64 **process creation FILETIME**, in 100 ns units since
  1601-01-01 UTC, always a string (never a JS number). Optional/null for process snapshots;
  mandatory for registry probes. Compared numerically against `GetProcessTimes` on the
  same limited-query process handle used for the remainder of the probe. Mismatch fails
  with `code:13, stage:"process.identity"` before token/registry inspection.
- `path`: HKCU-relative key path, e.g. `Software\\Vendor`; **do not prefix HKCU**.
  Empty means the target user's hive root. Maximum 512 UTF-16 code units; no NUL, slash,
  empty components, leading/trailing backslash, `.` or `..` components, or hive prefix.
- `name`: value name, up to 256 UTF-16 units, no NUL; empty denotes the default value.
  It is validated for event correlation only: Windows value access is controlled by the
  containing key DACL, and the helper neither reads nor tests the value's existence.
- `desiredAccess`: a nonzero combination of `KEY_QUERY_VALUE=1`, `KEY_SET_VALUE=2`,
  `KEY_CREATE_SUB_KEY=4`, `KEY_ENUMERATE_SUB_KEYS=8`, `KEY_NOTIFY=16` (allowed mask 31).
  No standard, generic, MAXIMUM_ALLOWED, WOW64 selector, CREATE_LINK or ALL_ACCESS masks.
- `allowParent`: required boolean. Only missing-key errors permit ancestor fallback.
- `observedAtMs`: optional nonnegative safe integer Unix milliseconds; absent/stale times cannot be correlated with historical events.

## Outcomes and response

`Outcome<T>` is exactly `{ "ok": true, "value": T }` or
`{ "ok": false, "error": "message", "code": 5, "stage": "token.open" }`.
`code` is always a numeric Win32 error code (including explicit validation/resource
codes); `errorCode` is never emitted. Missing values/APIs are failures, not empty success.

A handled envelope has these fields:

```text
{
  format: 1,
  observedAtMs: number,                 // Unix milliseconds at observation start
  uac: {
    EnableLUA: Outcome<number>,
    FilterAdministratorToken: Outcome<number>,
    ConsentPromptBehaviorAdmin: Outcome<number>,
    PromptOnSecureDesktop: Outcome<number>
  },
  processes: [{
    role: string, pid: number,
    ...Outcome<{
      pid: number, createdAt: string,
      elevated: boolean,
      elevationType: "default" | "full" | "limited",
      integrity: "untrusted" | "low" | "medium" | "mediumPlus" | "high" |
                 "system" | "protected" | "unknown:<decimal RID>",
      userSid: string,
      executable: Outcome<string>,
      fileVersion: Outcome<string>
    }>
  }],
  registry: [{
    eventId: string,
    ...Outcome<{
      requestedAccess: number, checkedAccess: number,
      checkedPath: string, ancestorUsed: boolean,
      daclAllowed: boolean, grantedAccess: number,
      pid: number, createdAt: string
    }>
  }],
  // Registry values also include securityDescriptor: Outcome<{sddl, ownerSid, groupSid,
  // daclPresent, daclNull, daclProtected, daclAutoInherited, aces, acesTruncated}>.
  vendorEvidence: {schemaVersion: 1, status: "collected" | "partial" | "unavailable",
    channels: [{name, status, code?, reason?, scanned, configuration?, events}],
    probes: [{failureEventId, status, reason?, code?, windowStartMs?, windowEndMs?}],
    auditPolicy, channelEnumeration, limits, attribution: "unsupported", reason?}
  // events are allowlisted, time/path/identity-correlated records, never full messages or values.
  // Only Security 4656 Audit Failure has operation "access_denied"; 4670 identifies the ACL actor.
  // Read-only collection returns within 7 seconds; no records does not establish absence of interference.
}
```

Process core fields are **flat inside `value`**, not nested Outcomes. A required token
field failure fails that process entry. Executable and FileVersion are independent
Outcomes and always present after core success; their failure never discards core fields.
`fileVersion` is the four numeric components of **VS_FIXEDFILEINFO FileVersion** from the
actual executable path obtained through the process handle. It is not ProductVersion,
package version, or a supplied version string. For a Node SEA executable it may be Node's
version. The resource is read from the file currently at that path, not the loaded image;
replacement between image load and file read is not detected. No version resource is an
explicit failure. Paths above 4096 UTF-8 bytes and version resources above 4 MiB fail only
the corresponding optional Outcomes.

Array order and valid identifiers are preserved. Invalid-entry identity echoes may be
null or truncated (role 64 characters/eventId 128) and are not trusted. No successful
sibling is removed by a failed probe. Each UAC DWORD is read separately with
`KEY_QUERY_VALUE | KEY_WOW64_64KEY` under
`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System`;
missing values remain explicit failures rather than inferred Windows defaults.

Invalid envelopes produce only `{format:1, observedAtMs, ok:false, error, code, stage}`;
no probes run. Input failures use `input.read`, `input.size`, `input.schema`,
`input.format`, or `input.count`. A final output size guard uses `output.size`.

## Registry evidence semantics

All process opens request only `PROCESS_QUERY_LIMITED_INFORMATION`. Snapshots request
only `TOKEN_QUERY`. Registry AccessCheck probes request `TOKEN_QUERY | TOKEN_DUPLICATE`
from that same process handle, then duplicate the target token as an impersonation token
with only `TOKEN_QUERY`. This token is passed to `AccessCheck`; it is never installed on
any helper thread. No privilege is enabled.

The helper opens **HKEY_USERS\\<target token user SID>\\<relative path>** in the 64-bit
registry view with **READ_CONTROL only** (plus the view selector). It never assumes its
own HKCU is the target user's. Hive-unloaded, access-denied and descriptor failures are
explicit failures; it never loads a hive. Owner, group and DACL are read together for a
complete AccessCheck descriptor. No SACL is requested.

For an existing target, `checkedAccess == requestedAccess` and `ancestorUsed == false`.
For a missing target with `allowParent`, the nearest existing parent is opened. Only
`KEY_CREATE_SUB_KEY` is checked there: `checkedAccess == 4`, `ancestorUsed == true`, and
`checkedPath` names that ancestor in full HKEY_USERS form. `requestedAccess` retains the
original mask for correlation. A deny returns a **successful check** with
`daclAllowed:false`; an API failure returns `ok:false` with its native code/stage.

**This is DACL evidence only.** Ancestor permission does not establish permission to
write the final target or to create every intermediate key. Even target DACL allowance
is not proof that integrity/policy, virtualization, registry links, a driver/security
product, or a concurrent ACL change will permit an operation. No vendor or “360 blocked”
conclusion is generated. A controller's thread impersonation token, if any, is outside
this contract: the probe explicitly checks the identified process's primary token.

## Build and focused verification

Rust 1.93, cached serde 1.0.229, serde_json 1.0.151, windows-sys 0.61.2. No winreg or
client runtime dependency. Use a real x64 MSVC toolchain/Windows SDK environment (not
Git's Unix `link.exe`). Set `CARGO_HOME=D:/Rust/.cargo` when necessary, and set
`CARGO_ENCODED_RUSTFLAGS` to `-C` + U+001F + `target-feature=+crt-static` (or ordinary
`RUSTFLAGS="-C target-feature=+crt-static"` if encoded flags are absent).
Release compilation refuses to proceed without static CRT. The build script under
`src/build.rs` emits `/timestamp:0` and, for release, `/DEBUG:NONE` to suppress Rust
NatVis-driven CodeView/PDB identities; the release profile enables stripping, panic abort, LTO,
a single codegen unit and no incremental compilation. A fixed timestamp avoids rust-lld
`/Brepro` hashes varying with temporary linker inputs. This removes link-time timestamps;
reproducible bytes additionally require identical locked dependencies/toolchain/build inputs.

From repository root:

```text
D:/Rust/.cargo/bin/cargo.exe build --offline --locked --release --target x86_64-pc-windows-msvc --manifest-path plugins/telemetry/native/Cargo.toml --target-dir build/telemetry-native
D:/Rust/.cargo/bin/cargo.exe test --offline --locked --target x86_64-pc-windows-msvc --manifest-path plugins/telemetry/native/Cargo.toml --target-dir build/telemetry-native
```

Artifact: `build/telemetry-native/x86_64-pc-windows-msvc/release/chord-observer.exe`.
The local fallback (no Visual Studio installation) uses these process-local environment values:

```powershell
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "D:/Rust/.rustup/toolchains/stable-x86_64-pc-windows-msvc/lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe"
$observerSdk = (Get-Location).Path + "/build/telemetry-native/toolchain/sdk"
$env:LIB = "$observerSdk/crt/lib/x86_64;$observerSdk/sdk/lib/um/x86_64;$observerSdk/sdk/lib/ucrt/x86_64"
$env:CARGO_ENCODED_RUSTFLAGS = "-C" + [char]31 + "target-feature=+crt-static"
```

The SDK/CRT were acquired with xwin 0.10.0 (x64 desktop only) in the ignored build tree;
these environment settings are a local verification fallback, not part of the shipping binary.
Local verification passed 10 unit tests plus 2 executable stdin/stdout integration tests
in the release profile, and `cargo clippy --all-targets -- -D warnings`.
A read-only probe against the known Node parent returned numeric FileVersion `26.7.0.0`,
matching Node `26.7.0`, with flat token core fields, independent mismatch/unknown failures,
and registry DACL evidence. The mixed probe completed in 18 ms with 1598 stdout bytes
and no stderr. PE inspection identified x64/console and only Windows system DLL imports
(advapi32, kernel32, version, ntdll, api-ms-win-core-synch-l1-2-0); no VC/UCRT runtime DLL.
These observations describe this machine; callers must still enforce their 10-second limit.

Keep all generated build outputs outside the source directory. Tests validate bounds,
path/access restrictions, unknown fields, real self-PID FILETIME matches/mismatches,
sibling isolation, actual process token against synthetic allow/deny DACLs in memory,
read-only registry descriptor queries, and nearest-parent behavior without registry writes.
