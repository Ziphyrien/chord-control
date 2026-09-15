import { createPublicKey, verify } from "node:crypto";

/** Stable UTF-8 representation, shared by the publisher and the controller. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("签名内容必须为 JSON");
  return text;
}
export function signingBytes(value: { signature?: string }): Buffer {
  const { signature: _signature, ...payload } = value;
  return Buffer.from(canonical(payload));
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
  const key = normalizePublicKey(publicKey);
  if (!verify(null, signingBytes(value), key, Buffer.from(value.signature, "base64"))) {
    throw new Error("发布签名校验失败，保留当前插件");
  }
}
