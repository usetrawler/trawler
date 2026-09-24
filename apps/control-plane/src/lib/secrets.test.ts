import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { decryptSecret, encryptSecret, last4, masterKeyFrom } from "./secrets.ts";

const key = randomBytes(32);
const context = "org-a:target_account";

test("round trips and never stores the plain text", () => {
  const box = encryptSecret("hunter22-secret", key, context);
  expect(box.startsWith("v1:")).toBe(true);
  expect(box).not.toContain("hunter22");
  expect(decryptSecret(box, key, context)).toBe("hunter22-secret");
});

test("the same secret encrypts differently every time", () => {
  expect(encryptSecret("same", key, context)).not.toBe(encryptSecret("same", key, context));
});

test("tampering, a wrong key or another context is detected", () => {
  const box = encryptSecret("hunter22-secret", key, context);
  const parts = box.split(":");
  const flipped = [...parts];
  flipped[3] = Buffer.from(Buffer.from(parts[3]!, "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url");
  expect(() => decryptSecret(flipped.join(":"), key, context)).toThrow(/could not be decrypted/);
  expect(() => decryptSecret(box, randomBytes(32), context)).toThrow(/could not be decrypted/);
  expect(() => decryptSecret(box, key, "org-b:target_account")).toThrow(/could not be decrypted/);
  expect(() => decryptSecret("v9:a:b:c", key, context)).toThrow(/unknown secret format/);
  expect(() => decryptSecret("garbage", key, context)).toThrow(/unknown secret format/);
});

test("the error never contains the ciphertext or key", () => {
  const box = encryptSecret("hunter22-secret", key, context);
  try {
    decryptSecret(box, randomBytes(32), context);
  } catch (err) {
    expect(String(err)).not.toContain(box.split(":")[3]);
  }
});

test("last4 shows only the end of a secret", () => {
  expect(last4("sk-or-v1-abcdef9f3a")).toBe("…9f3a");
  expect(last4("abc")).toBe("…");
});

test("the master key must be 32 bytes of base64", () => {
  expect(masterKeyFrom(randomBytes(32).toString("base64")).length).toBe(32);
  expect(() => masterKeyFrom(undefined)).toThrow(/TRAWLER_MASTER_KEY/);
  expect(() => masterKeyFrom(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
});
