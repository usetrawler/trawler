import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function canonical(value: string): Buffer | null {
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

export function masterKeyFrom(value: string | undefined, name = "TRAWLER_MASTER_KEY"): Buffer {
  if (!value) throw new Error(`${name} is not set`);
  const key = Buffer.from(value, "base64");
  if (key.toString("base64") !== value) throw new Error(`${name} must be canonical base64`);
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  if (new Set(key).size < 8) throw new Error(`${name} does not look random`);
  return key;
}

const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

export class Keyring {
  readonly #active: Buffer;
  readonly #keys = new Map<string, Buffer>();

  constructor(active: Buffer, previous: Buffer[] = []) {
    for (const key of [active, ...previous]) {
      if (key.length !== 32) throw new Error("encryption keys must be 32 bytes");
      const id = keyId(key);
      const known = this.#keys.get(id);
      if (known && !known.equals(key)) throw new Error("two different keys share an id");
      this.#keys.set(id, Buffer.from(key));
    }
    this.#active = Buffer.from(active);
  }

  encrypt(plain: string, context: string[]): string {
    if (!plain.isWellFormed()) throw new Error("secrets must be well formed text");
    if (context.length === 0) throw new Error("a secret must be bound to a context");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#active, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(JSON.stringify(context)));
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [VERSION, keyId(this.#active), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
  }

  decrypt(box: string, context: string[]): string {
    const [version, kid, ivText, tagText, dataText, ...rest] = box.split(":");
    const iv = ivText === undefined ? null : canonical(ivText);
    const tag = tagText === undefined ? null : canonical(tagText);
    const data = dataText === undefined ? null : canonical(dataText);
    if (version !== VERSION || !kid || rest.length > 0 || !iv || !tag || !data || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error("unknown secret format");
    }
    const key = this.#keys.get(kid);
    if (!key) throw new Error("the secret was encrypted with an unknown key");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(JSON.stringify(context)));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("the secret could not be decrypted");
    }
  }
}

export function keyringFromEnv(env: Record<string, string | undefined> = process.env): Keyring {
  const previous = (env.TRAWLER_PREVIOUS_MASTER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean).map((k) => masterKeyFrom(k, "TRAWLER_PREVIOUS_MASTER_KEYS"));
  return new Keyring(masterKeyFrom(env.TRAWLER_MASTER_KEY), previous);
}

export function last4(secret: string): string {
  const chars = Array.from(secret);
  return chars.length >= 16 ? `…${chars.slice(-4).join("")}` : "…";
}
