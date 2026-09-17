import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMain, repositoryRoot, withDirectoryLock } from "./release-files.mjs";

/** Create a complete key pair once; an existing destination is never replaced. */
export async function generateKey(output = join(repositoryRoot, ".local/signing")) {
  return withDirectoryLock(output, async () => {
    await mkdir(dirname(output), { recursive: true });
    const temporary = await mkdtemp(`${output}.stage-`);
    try {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      await writeFile(
        join(temporary, "private.pem"),
        privateKey.export({ format: "pem", type: "pkcs8" }),
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(
        join(temporary, "public.pem"),
        publicKey.export({ format: "pem", type: "spki" }),
        { flag: "wx" },
      );
      // Windows rejects replacing any existing directory; POSIX rejects nonempty ones.
      await mkdir(output);
      try {
        await rename(join(temporary, "private.pem"), join(output, "private.pem"));
        await rename(join(temporary, "public.pem"), join(output, "public.pem"));
      } catch (error) {
        await rm(output, { recursive: true, force: true });
        throw error;
      }
      return output;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

if (isMain(import.meta.url))
  console.log(
    `Created key pair in ${await generateKey()}; store private.pem as PLUGIN_SIGNING_PRIVATE_KEY, never in Git.`,
  );
