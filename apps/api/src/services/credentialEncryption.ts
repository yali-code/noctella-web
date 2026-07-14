import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) throw new Error("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY is required");
  const b = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 44 ? Buffer.from(raw, "base64") : Buffer.from(raw, "hex");
  if (b.length !== 32) throw new Error("MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes");
  return b;
}

export function encryptCredential(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptCredential(value: string): string {
  const [v, iv, tag, data] = value.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Invalid encrypted credential");
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
