// Static source/metadata audit only. No Rust compilation, native execution or state changes.
// Run with the repository's existing Bun: bun src-tauri/scripts/static-audit.mjs
// --sync-lock updates only the root dependency edges and prunes unreachable existing entries;
// it never resolves/downloads dependencies or changes a third-party version/checksum.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(resolve(root, name), "utf8");
const cargo = Bun.TOML.parse(read("Cargo.toml"));
let lockText = read("Cargo.lock");
let lock = Bun.TOML.parse(lockText);
const packages = lock.package;
const key = (pkg) => `${pkg.name} ${pkg.version}`;
const candidates = (name) => packages.filter((pkg) => pkg.name === name);
function dependency(ref) {
  const [name, version] = ref.split(" ");
  const matches = candidates(name).filter((pkg) => !version || pkg.version === version);
  assert.equal(matches.length, 1, `ambiguous or missing lock dependency ${ref}`);
  return matches[0];
}
const manifests = [
  cargo.dependencies,
  cargo["build-dependencies"],
  ...Object.values(cargo.target ?? {}).map((target) => target.dependencies),
];
const expected = new Map(manifests.flatMap((group) => Object.entries(group ?? {})));
const rootPackage = packages.find((pkg) => pkg.name === cargo.package.name);
assert(rootPackage, "root package missing");
if (process.argv.includes("--sync-lock")) {
  const dependencies = [...expected]
    .map(([name, spec]) => {
      const version = typeof spec === "string" ? spec : spec.version;
      const matches = candidates(name).filter(
        (pkg) => pkg.version === version || pkg.version.startsWith(`${version}.`),
      );
      assert.equal(matches.length, 1, `static lock refresh cannot resolve ${name} ${version}`);
      return candidates(name).length > 1 ? key(matches[0]) : name;
    })
    .sort();
  rootPackage.version = cargo.package.version;
  rootPackage.dependencies = dependencies;
  const reachable = new Set();
  function visit(pkg) {
    if (reachable.has(key(pkg))) return;
    reachable.add(key(pkg));
    for (const dep of pkg.dependencies ?? []) visit(dependency(dep));
  }
  visit(rootPackage);
  const blocks = lockText.split(/(?=^\[\[package\]\]$)/m);
  const header = blocks.shift();
  const retained = blocks
    .filter((block) => {
      const pkg = Bun.TOML.parse(block).package[0];
      return pkg.name === rootPackage.name || reachable.has(key(pkg));
    })
    .map((block) => {
      if (Bun.TOML.parse(block).package[0].name !== rootPackage.name) return block;
      return `[[package]]\nname = "${rootPackage.name}"\nversion = "${rootPackage.version}"\ndependencies = [\n${dependencies.map((dep) => ` "${dep}",`).join("\n")}\n]\n\n`;
    });
  lockText = header + retained.join("");
  writeFileSync(resolve(root, "Cargo.lock"), lockText);
  lock = Bun.TOML.parse(lockText);
}
const lockedRoot = lock.package.find((pkg) => pkg.name === cargo.package.name);
assert.equal(cargo.package.version, "0.3.0");
assert.equal(lockedRoot.version, cargo.package.version);
assert.deepEqual(
  new Set(lockedRoot.dependencies.map((dep) => dep.split(" ")[0])),
  new Set(expected.keys()),
);
for (const pkg of lock.package) {
  for (const dep of pkg.dependencies ?? []) {
    const [name, version] = dep.split(" ");
    assert.equal(
      lock.package.filter(
        (candidate) => candidate.name === name && (!version || candidate.version === version),
      ).length,
      1,
      `${key(pkg)} -> ${dep}`,
    );
  }
}
const config = JSON.parse(read("tauri.conf.json"));
const release = JSON.parse(read("tauri.release.conf.json"));
const capability = JSON.parse(read("capabilities/default.json"));
assert.equal(config.version, cargo.package.version);
assert.equal(config.identifier, "com.chord.control");
assert.equal(config.app.windows.find((window) => window.label === "main").visible, false);
assert.equal(config.app.windows.find((window) => window.label === "main").focus, false);
assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
assert.equal(config.bundle.windows.nsis.template, "windows/installer.nsi");
assert.equal(release.bundle.createUpdaterArtifacts, true);
assert.deepEqual(config.bundle.externalBin, ["binaries/plugin-controller"]);
assert.deepEqual(capability.windows, ["main"]);
assert.equal(capability.local, true);
assert(!capability.remote);
assert(
  capability.permissions.every((permission) =>
    /^(core:event:allow-(listen|unlisten)|autostart:allow-(enable|disable|is-enabled))$/.test(
      permission,
    ),
  ),
);
assert.equal(
  config.plugins.updater.pubkey,
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYxMzM4RTc2QTQ5MjZDN0UKUldSK2JKS2tkbzR6OGF0OFBnWDNTalMzcm1sUWlHMzhIOC90T0ZKV1BHYWsvL2VUN3FYcHJ1ak4K",
);
// Check configuration keys against the installed CLI schema (no package installation).
const schema = JSON.parse(
  readFileSync(resolve(root, "../node_modules/@tauri-apps/cli/config.schema.json"), "utf8"),
);
function checkSchema(value, definition, path) {
  if (definition.$ref)
    return checkSchema(value, schema.definitions[definition.$ref.split("/").at(-1)], path);
  if (definition.anyOf || definition.oneOf) {
    const branches = definition.anyOf ?? definition.oneOf;
    assert(
      branches.some((branch) => {
        try {
          checkSchema(value, branch, path);
          return true;
        } catch {
          return false;
        }
      }),
      `schema alternatives failed at ${path}`,
    );
    return;
  }
  if (definition.enum) assert(definition.enum.includes(value), `schema enum at ${path}`);
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (definition.type) {
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    assert(
      types.includes(type) || (types.includes("integer") && Number.isInteger(value)),
      `schema type at ${path}`,
    );
  }
  if (type === "object") {
    for (const required of definition.required ?? [])
      assert(Object.hasOwn(value, required), `missing ${path}.${required}`);
    for (const [name, field] of Object.entries(value)) {
      const nested = definition.properties?.[name];
      if (nested) checkSchema(field, nested, `${path}.${name}`);
      else assert(definition.additionalProperties !== false, `unknown ${path}.${name}`);
    }
  }
  if (type === "array" && definition.items)
    value.forEach((item, index) => checkSchema(item, definition.items, `${path}[${index}]`));
}
checkSchema(config, schema, "config");
checkSchema(
  { ...config, ...release, bundle: { ...config.bundle, ...release.bundle } },
  schema,
  "release overlay",
);
const sources = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name.endsWith(".rs"))
      sources.push([relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")]);
  }
}
collect(resolve(root, "src"));
sources.push(["build.rs", read("build.rs")]);
const rust = sources.map(([, text]) => text).join("\n");
assert(
  !/msedge\.exe|chrome\.exe|password-pad|study-guard|app-guard|SystemParametersInfoA|powershell|taskkill/i.test(
    rust,
  ),
  "plugin policy or script execution leaked into native host",
);
const wire = read("src/wire.rs");
for (const name of [
  "snapshot",
  "check_updates",
  "set_settings",
  "add_plugin",
  "install",
  "set_enabled",
  "remove_plugin",
  "plugin_ui",
  "plugin_call",
])
  assert(wire.includes(`"${name}"`), `missing command ${name}`);
assert(wire.includes("affectedPluginIds"));
for (const name of [
  "desktop_action",
  "plugin_window_closed",
  "native_request",
  "native_response",
  "plugin_window",
])
  assert(rust.includes(`"${name}"`));
for (const command of ["controller::controller_command", "desktop::open_data_directory"])
  assert(read("src/lib.rs").includes(command), `unregistered ${command}`);
for (const module of [
  "controller",
  "desktop",
  "guard",
  "lifecycle",
  "logging",
  "native",
  "plugin_windows",
  "shell_launch",
  "sync",
  "tray",
  "updater",
  "wire",
])
  assert(read("src/lib.rs").includes(`mod ${module};`));
assert(read("src/controller.rs").includes("generation == generation && !c.force.is_cancelled()"));
assert(read("src/controller/transport.rs").includes("CancelSynchronousIo"));
assert(read("src/shell_launch.rs").includes("CoCancelCall"));
assert(read("src/shell_launch.rs").includes("QueryActiveShellView"));
assert(read("src/guard/session.rs").includes("Guard resume token was revoked"));
assert(read("src/native/process.rs").includes('"createdAt":created_at'));
const installer = read("windows/installer.nsi");
assert(installer.includes("RequestExecutionLevel user"));
assert(!/^\s*(WriteUninstaller|CreateShortCut|Section\s+['"]?Uninstall)\b/im.test(installer));
assert(
  !/WriteReg\w*\s+HKLM|needsadmin=true|RunAsUser|KillProcessCurrentUser/.test(
    installer + read("windows/hooks.nsh"),
  ),
);
assert(!/WriteReg\w*[^\n]*CurrentVersion\\Uninstall/.test(installer));
assert(installer.includes("NSIS_HOOK_PREINSTALL") && installer.includes("NSIS_HOOK_POSTINSTALL"));
const assets = [
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/icon.ico",
  "binaries/plugin-controller-x86_64-pc-windows-msvc.exe",
];
const hashes = assets.map((path) => {
  const bytes = readFileSync(resolve(root, path));
  if (path.endsWith(".png")) assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  if (path.endsWith(".ico")) assert.equal(bytes.readUInt32LE(0), 0x10000);
  if (path.endsWith(".exe")) assert.equal(bytes.subarray(0, 2).toString(), "MZ");
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
});
console.log(
  JSON.stringify(
    {
      status: "static audit passed",
      rustFiles: sources.length,
      lockedPackages: lock.package.length,
      note: "Schema traversal checks keys/types/enums, not a replacement for Tauri compilation or Windows execution.",
      assets: hashes,
    },
    null,
    2,
  ),
);
