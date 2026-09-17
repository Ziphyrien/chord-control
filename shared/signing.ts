import { createPublicKey, verify } from "node:crypto";

/** Canonical JSON encoding is a wire contract, preserved across publisher/controller versions. */
function encode(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("签名不能包含非有限数字");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("签名内容必须为 JSON");
  return encoded;
}
export function signingBytes(value: { signature?: string }): Buffer {
  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature"));
  return Buffer.from(encode(payload), "utf8");
}
export function normalizePublicKey(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("发布者公钥必须使用 Ed25519");
  return key.export({ type: "spki", format: "pem" }).toString();
}
export function verifySigned(
  value: { signature?: string },
  publicKey: string,
  allowUnsigned = false,
): void {
  if (allowUnsigned && !publicKey && !value.signature) return;
  if (!publicKey || !value.signature) throw new Error("缺少发布者公钥或发布签名");
  const signature = Buffer.from(value.signature, "base64");
  if (
    signature.length !== 64 ||
    !verify(null, signingBytes(value), normalizePublicKey(publicKey), signature)
  )
    throw new Error("发布签名校验失败，保留当前插件");
}
