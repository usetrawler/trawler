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
  test("a combining mark typed after the secret does not hide it", () => {
    expect(scrubbed("hunter2e", "value: hunter2e\u0301 end")).toBe("value: •••\u0301 end");
  });
  test("matches a secret stored in mixed normalisation, as typed", () => {
    const mixed = "p\u00e4o\u0308sswrd1";
    expect(mixed).not.toBe(mixed.normalize("NFC"));
    expect(mixed).not.toBe(mixed.normalize("NFD"));
    expect(scrubbed(mixed, `fill('${mixed}') q=${encodeURIComponent(mixed)}`)).toBe("fill('•••') q=•••");
  });
  test("removes percent-encoded forms of a decomposed secret", () => {
    const nfd = "pässwörd1".normalize("NFD");
    expect(scrubbed(nfd, `q=${encodeURIComponent(nfd)}`)).toBe("q=•••");
  });
  test.each(["&#x27;", "&apos;"])("removes the HTML form using %s for the apostrophe", (entity) => {
    expect(scrubbed("it's-secret", `<p>it${entity}s-secret</p>`)).toBe("<p>•••</p>");
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
  test("an object referenced twice is kept twice, not called circular", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    const shared = { pw: "hunter22" };
    expect(s.scrub({ a: shared, b: shared })).toEqual({ a: { pw: "•••" }, b: { pw: "•••" } });
  });
  test("wide typed arrays are not decoded as text", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub(new Uint16Array([104, 117, 110, 116, 101, 114, 50, 50]))).toBe("[binary]");
  });
  test("typed arrays are decoded before scrubbing", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub(new TextEncoder().encode("pw=hunter22"))).toBe("pw=•••");
  });
  test("functions are dropped, so toJSON cannot smuggle a secret out", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(JSON.stringify(s.scrub({ ok: 1, toJSON: () => "hunter22" }))).toBe('{"ok":1}');
  });
  test("an Error's name is scrubbed too", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub(Object.assign(new Error("x"), { name: "hunter22" }))).toEqual({ name: "•••", message: "x" });
  });
  test("an object whose conversion throws becomes a placeholder", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    const odd = new (class { toString(): string { throw new Error("no"); } })();
    expect(s.scrub(odd)).toBe("[unserialisable]");
  });
  test("buffers and other objects are scrubbed as text", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub(Buffer.from("pw=hunter22"))).toBe("pw=•••");
  });
});

describe("SecretScrubber.forProject", () => {
  test("registers every password, basic auth in raw and base64 form, and secret headers only", () => {
    const s = SecretScrubber.forProject({
      accounts: [{ password: "first-pass" }, { password: "second-pass" }],
      httpCredentials: { username: "staging", password: "gate-pass-1" },
      secretHeaders: { "x-vercel-protection-bypass": "bypass-token-123" },
    });
    const basic = Buffer.from("staging:gate-pass-1").toString("base64");
    expect(s.scrub(`first-pass second-pass gate-pass-1 Basic ${basic} bypass-token-123 production`)).toBe("••• ••• ••• Basic ••• ••• production");
  });
});
