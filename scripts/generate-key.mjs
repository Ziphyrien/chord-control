import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(".local/signing");
await mkdir(output, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await writeFile(`${output}/private.pem`, privateKey.export({ format: "pem", type: "pkcs8" }), {
  flag: "wx",
  mode: 0o600,
});
await writeFile(`${output}/public.pem`, publicKey.export({ format: "pem", type: "spki" }), {
  flag: "wx",
});
console.log(
  `Created ${output}/private.pem and public.pem. Keep the private key outside Git; put it in the PLUGIN_SIGNING_PRIVATE_KEY Actions secret.`,
);
