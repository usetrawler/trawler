import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function masterKeyFrom(value: string | undefined): Buffer {
  if (!value) throw new Error("TRAWLER_MASTER_KEY is not set");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("TRAWLER_MASTER_KEY must be 32 bytes, base64 encoded");
  return key;
}

export function encryptSecret(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

export function decryptSecret(box: string, key: Buffer, context: string): string {
  const [version, iv, tag, data, ...rest] = box.split(":");
  if (version !== VERSION || !iv || !tag || data === undefined || rest.length > 0) throw new Error("unknown secret format");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("the secret could not be decrypted");
  }
}

export function last4(secret: string): string {
  return secret.length >= 8 ? `…${secret.slice(-4)}` : "…";
}
