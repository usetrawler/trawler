import { createCipheriv, randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { Keyring, last4, masterKeyFrom } from "./secrets.ts";

const key = randomBytes(32);
const ring = new Keyring(key);
const where = ["org-a", "target_account", "acc-1", "password"];

test("round trips and never stores the plain text", () => {
  const box = ring.encrypt("hunter22-secret", where);
  expect(box.startsWith("v1:")).toBe(true);
  expect(box).not.toContain("hunter22");
  expect(ring.decrypt(box, where)).toBe("hunter22-secret");
});

test("the same secret encrypts differently every time", () => {
  expect(ring.encrypt("same", where)).not.toBe(ring.encrypt("same", where));
});

test("tampering, a wrong key, another row or a shifted context boundary is detected", () => {
  const box = ring.encrypt("hunter22-secret", where);
  const parts = box.split(":");
  const flipped = [...parts];
  flipped[4] = Buffer.from(Buffer.from(parts[4]!, "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url");
  expect(() => ring.decrypt(flipped.join(":"), where)).toThrow(/could not be decrypted/);
  expect(() => new Keyring(randomBytes(32)).decrypt(box, where)).toThrow(/unknown key/);
  expect(() => ring.decrypt(box, ["org-a", "target_account", "acc-2", "password"])).toThrow(/could not be decrypted/);
  expect(() => ring.decrypt(box, ["org-a:target_account", "acc-1", "password"])).toThrow(/could not be decrypted/);
});

test("a truncated tag, a wrong IV length or non-canonical encoding is refused", () => {
  const box = ring.encrypt("hunter22-secret", where);
  const [v, kid, iv, tag, data] = box.split(":");
  const shortTag = Buffer.from(tag!, "base64url").subarray(0, 4).toString("base64url");
  expect(() => ring.decrypt([v, kid, iv, shortTag, data].join(":"), where)).toThrow(/unknown secret format/);
  expect(() => ring.decrypt([v, kid, randomBytes(16).toString("base64url"), tag, data].join(":"), where)).toThrow(/unknown secret format/);
  expect(() => ring.decrypt([v, kid, `${iv}!!`, tag, data].join(":"), where)).toThrow(/unknown secret format/);
  expect(() => ring.decrypt("v9:a:b:c:d", where)).toThrow(/unknown secret format/);
  expect(() => ring.decrypt("garbage", where)).toThrow(/unknown secret format/);
});

test("forged ciphertext with a short tag does not decrypt even where the runtime allows short tags", () => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 4 });
  cipher.setAAD(Buffer.from(JSON.stringify(where)));
  const data = Buffer.concat([cipher.update("forged"), cipher.final()]);
  const kid = ring.encrypt("x", where).split(":")[1];
  expect(() => ring.decrypt(["v1", kid, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":"), where)).toThrow(/unknown secret format/);
});

test("old keys still decrypt after rotation, new secrets use the active key", () => {
  const old = new Keyring(key);
  const box = old.encrypt("hunter22-secret", where);
  const rotated = new Keyring(randomBytes(32), [key]);
  expect(rotated.decrypt(box, where)).toBe("hunter22-secret");
  expect(rotated.encrypt("x", where).split(":")[1]).not.toBe(box.split(":")[1]);
});

test("the error never contains the ciphertext or key", () => {
  const box = ring.encrypt("hunter22-secret", where);
  try {
    ring.decrypt(box, ["other"]);
  } catch (err) {
    expect(String(err)).not.toContain(box.split(":")[4]);
  }
});

test("text that is not well formed is refused", () => {
  expect(() => ring.encrypt("\uD800", where)).toThrow(/well formed/);
});

test("last4 shows the end only of long secrets", () => {
  expect(last4("sk-or-v1-abcdef1234569f3a")).toBe("…9f3a");
  expect(last4("hunter22")).toBe("…");
  expect(last4("abc")).toBe("…");
});

test("the master key must be 32 random-looking bytes in canonical base64", () => {
  expect(masterKeyFrom(randomBytes(32).toString("base64")).length).toBe(32);
  expect(() => masterKeyFrom(undefined)).toThrow(/TRAWLER_MASTER_KEY/);
  expect(() => masterKeyFrom(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  expect(() => masterKeyFrom("my-trawler-production-master-key-please-ok")).toThrow(/base64/);
  expect(() => masterKeyFrom(Buffer.alloc(32, 7).toString("base64"))).toThrow(/random/);
});

test("a key of the wrong size is a configuration error, not a decryption failure", () => {
  expect(() => new Keyring(randomBytes(16))).toThrow(/32 bytes/);
});
