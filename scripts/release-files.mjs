import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
export const isMain = (url) =>
  Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url));

export function releaseTime(value = process.env.SOURCE_DATE_EPOCH) {
  if (value === undefined) return "2020-01-01T00:00:00.000Z";
  if (!/^\d+$/.test(String(value))) throw new Error("SOURCE_DATE_EPOCH must be integer seconds");
  const date = new Date(Number(value) * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid release timestamp");
  return date.toISOString();
}

export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Serialize writers without silently breaking an active or abandoned lock. */
export async function withDirectoryLock(directory, operation) {
  const lock = `${resolve(directory)}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Another writer owns ${lock}; remove only after confirming it stopped`);
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Discover packages, ignoring support directories; malformed manifests fail visibly. */
export async function discoverPackages(root) {
  const packages = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    compareNames(a.name, b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    try {
      packages.push({ directory, manifest: await readJson(join(directory, "package.json")) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return packages;
}
