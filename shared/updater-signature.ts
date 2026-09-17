import { createHash, createPublicKey, verify } from "node:crypto";

function base64(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("Malformed updater base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Noncanonical updater base64");
  return bytes;
}

/** Verify both minisign signatures against the unchanged Tauri updater public key. */
export function verifyUpdaterSignature(bytes: Uint8Array, signature: string, publicKey: string) {
  const keyLines = base64(publicKey.trim()).toString("utf8").trim().split(/\r?\n/);
  const lines = base64(signature.trim()).toString("utf8").trim().split(/\r?\n/);
  if (
    keyLines.length !== 2 ||
    !keyLines[0].startsWith("untrusted comment:") ||
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment:") ||
    !lines[2].startsWith("trusted comment: ")
  )
    throw new Error("Malformed minisign envelope");
  const key = base64(keyLines[1]);
  const packet = base64(lines[1]);
  const global = base64(lines[3]);
  if (
    key.length !== 42 ||
    packet.length !== 74 ||
    global.length !== 64 ||
    key.subarray(0, 2).toString() !== "Ed" ||
    !key.subarray(2, 10).equals(packet.subarray(2, 10))
  )
    throw new Error("Updater signing key mismatch");
  const algorithm = packet.subarray(0, 2).toString();
  if (!["Ed", "ED"].includes(algorithm)) throw new Error("Unsupported updater signature algorithm");
  const pem = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const rawSignature = packet.subarray(10);
  const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  if (
    !verify(null, message, pem, rawSignature) ||
    !verify(
      null,
      Buffer.concat([rawSignature, Buffer.from(lines[2].slice("trusted comment: ".length))]),
      pem,
      global,
    )
  )
    throw new Error("Updater signature verification failed");
}
