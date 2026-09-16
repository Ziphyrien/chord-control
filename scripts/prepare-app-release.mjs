import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { currentRepositorySlug } from "./repository-config.mjs";

const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const project = JSON.parse(await readFile("package.json", "utf8"));
if (config.version !== project.version) throw new Error("App versions differ");
const tag = `app-v${config.version}`;
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== tag)
  throw new Error("Release tag does not match app version");
const repository = currentRepositorySlug();
if (!repository) throw new Error("GitHub repository is required");
const bundle = "src-tauri/target/release/bundle/nsis";
const installers = (await readdir(bundle)).filter(
  (name) => name.endsWith(".exe") && !name.endsWith(".sig"),
);
if (installers.length !== 1) throw new Error("Expected one Windows installer");
const installer = join(bundle, installers[0]);
const signature = (await readFile(`${installer}.sig`, "utf8")).trim();
if (
  !signature ||
  !Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:")
)
  throw new Error("Updater signature is missing or malformed");
const output = "release/app";
await mkdir(output, { recursive: true });
const name = "Chord.Control-setup.exe";
await copyFile(installer, join(output, name));
await writeFile(join(output, `${name}.sig`), signature + "\n");
const sidecar = "plugin-controller-x86_64-pc-windows-msvc.exe";
await copyFile(join("src-tauri/binaries", sidecar), join(output, sidecar));
const latest = {
  version: config.version,
  notes: `Chord Control ${config.version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    },
  },
};
await writeFile(join(output, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
const checksums = [];
for (const file of [name, `${name}.sig`, sidecar, "latest.json"]) {
  const bytes = await readFile(join(output, file));
  if (!bytes.length) throw new Error(`Empty release asset: ${file}`);
  checksums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
await writeFile(join(output, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
console.log(`Prepared ${tag}: installer, signature, sidecar, latest.json and SHA256SUMS.txt`);
