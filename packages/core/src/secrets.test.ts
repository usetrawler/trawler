import { describe, expect, test } from "vitest";
import { SecretScrubber } from "./secrets.ts";

function scrubbed(secret: string, text: string): string {
  const s = new SecretScrubber();
  s.add(secret);
  return s.scrub(text);
}

const tricky = `p@ss w"rd/1&<x>'!`;

describe("SecretScrubber forms", () => {
  test.each([
    ["raw", tricky],
    ["JSON-escaped", JSON.stringify(tricky).slice(1, -1)],
    ["double JSON-escaped", JSON.stringify(JSON.stringify(tricky).slice(1, -1)).slice(1, -1)],
    ["Playwright single-quoted", JSON.stringify(tricky).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")],
    ["HTML-escaped", tricky.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")],
    ["encodeURIComponent", encodeURIComponent(tricky)],
    ["encodeURI", encodeURI(tricky)],
    ["form-encoded", new URLSearchParams({ x: tricky }).toString().slice(2)],
    ["lower-case percent", encodeURIComponent(tricky).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
  ])("removes the %s form", (_label, form) => {
    expect(scrubbed(tricky, `before ${form} after`)).toBe("before ••• after");
  });

  test("matches a decomposed unicode form", () => {
    expect(scrubbed("pässwort-1", "x pässwort-1 y")).toBe("x ••• y");
  });
});

describe("SecretScrubber masking", () => {
  test("replaces secrets deep inside plain values without mutating them", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    const input = { a: ["pw hunter22 end"], b: 3, c: null };
    expect(s.scrub(input)).toEqual({ a: ["pw ••• end"], b: 3, c: null });
    expect(input.a[0]).toBe("pw hunter22 end");
  });
  test("refuses secrets too short to scrub reliably", () => {
    expect(() => new SecretScrubber().add("abc1234")).toThrow(RangeError);
  });
  test("a secret that contains another is removed whole", () => {
    const s = new SecretScrubber();
    s.add("password");
    s.add("password123");
    expect(s.scrub("typed password123 here")).toBe("typed ••• here");
  });
  test("overlapping secrets leave no fragment", () => {
    const s = new SecretScrubber();
    s.add("abcdefgh");
    s.add("efghijkl");
    expect(s.scrub("xabcdefghijkly")).toBe("x•••y");
  });
  test("repeated characters leave no fragment", () => {
    expect(scrubbed("aaaaaaaa", "aaaaaaaaaa!")).toBe("•••!");
  });
  test("an Error keeps its message, scrubbed", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub(new Error("could not fill 'hunter22'"))).toEqual({ name: "Error", message: "could not fill '•••'" });
  });
  test("circular values do not throw", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    const o: Record<string, unknown> = { pw: "hunter22" };
    o.self = o;
    expect(s.scrub(o)).toEqual({ pw: "•••", self: "[circular]" });
  });
  test("buffers and other objects are scrubbed as text", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub(Buffer.from("pw=hunter22"))).toBe("pw=•••");
  });
});

describe("SecretScrubber.forProject", () => {
  test("registers every password, basic auth in raw and base64 form, and long header values", () => {
    const s = SecretScrubber.forProject({
      accounts: [{ password: "first-pass" }, { password: "second-pass" }],
      httpCredentials: { username: "staging", password: "gate-pass-1" },
      extraHeaders: { "x-vercel-protection-bypass": "bypass-token-123", "x-env": "stg" },
    });
    const basic = Buffer.from("staging:gate-pass-1").toString("base64");
    expect(s.scrub(`first-pass second-pass gate-pass-1 Basic ${basic} bypass-token-123 stg`)).toBe("••• ••• ••• Basic ••• ••• stg");
  });
});
