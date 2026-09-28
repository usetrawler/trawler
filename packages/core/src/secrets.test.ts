import { Worker } from "node:worker_threads";
import { describe, expect, test } from "vitest";
import { SecretScrubber } from "./secrets.ts";

function scrubbed(secret: string, text: string): string {
  const s = new SecretScrubber();
  s.add(secret);
  return s.scrub(text);
}

const tricky = `p@ss w"rd/1&<x>'!`;

function scrubInSmallHeap(unit: string): Promise<unknown> {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.url).then(({ SecretScrubber }) => {
      const s = new SecretScrubber();
      s.add(workerData.unit.repeat(20 / workerData.unit.length));
      parentPort.postMessage(s.scrub(workerData.unit.repeat(16_000_000 / workerData.unit.length)));
    });`,
    { eval: true, workerData: { url: new URL("./secrets.ts", import.meta.url).href, unit }, resourceLimits: { maxOldGenerationSizeMb: 64 } },
  );
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

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
  test("touching copies of a secret become one mask, and copies with a gap stay apart", () => {
    expect(scrubbed("hunter22", "hunter22hunter22")).toBe("•••");
    expect(scrubbed("hunter22", "xhunter22hunter22hunter22 hunter22y")).toBe("x••• •••y");
    expect(scrubbed("abababab", "abababababab.ababababa")).toBe("•••.•••a");
  });
  test("a run of one secret still joins another secret that overlaps its end", () => {
    const s = new SecretScrubber();
    s.add("aaaaaaaa");
    s.add("aaab1234");
    expect(s.scrub("xaaaaaaaaaaab1234y")).toBe("x•••y");
    expect(s.scrub("aaab1234aaaaaaaa")).toBe("•••");
  });
  test("masks 16 MB of a secret's own repeating pattern within a 64 MB heap", async () => {
    for (const unit of ["a", "ab"]) expect(await scrubInSmallHeap(unit)).toBe("•••");
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
  test("object keys are scrubbed too", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub({ hunter22: 1 })).toEqual({ "•••": 1 });
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
  test("a secret the browser never holds is scrubbed like any other but is kept out of what the browser is given to look for", () => {
    const s = new SecretScrubber();
    s.add("page-password-1");
    s.add("runner-token-1", { reachesBrowser: false });
    expect(s.scrub("page-password-1 runner-token-1")).toBe("••• •••");
    expect(s.browserNeedles()).toContain("page-password-1");
    expect(s.browserNeedles()).toContain(encodeURIComponent("page-password-1"));
    expect(s.browserNeedles().some((n) => n.includes("runner-token"))).toBe(false);
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
  test("leaves passwords too short to mask reliably unmasked and masks those of 8 characters and more", () => {
    const s = SecretScrubber.forProject({ accounts: [{ password: "user" }, { password: "pw8chars" }], httpCredentials: { username: "u", password: "p" }, secretHeaders: {} });
    expect(Buffer.from("u:p").toString("base64")).toBe("dTpw");
    expect(s.scrub("Username: user, then pw8chars, then p and dTpw")).toBe("Username: user, then •••, then p and dTpw");
  });
  test("a secret header with an auth scheme masks its token on its own too, whatever the scheme's case", () => {
    for (const scheme of ["Bearer", "bearer", "TOKEN", "Bot"]) {
      const s = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: `${scheme}  sk-live-token-42` } });
      expect(s.scrub(`${scheme}  sk-live-token-42 ; key sk-live-token-42; "sk-live-token-42"`)).toBe(`••• ; key •••; "•••"`);
    }
  });
  test("a secret header with Basic masks the encoded token, the decoded user and password, and the password alone", () => {
    const token = Buffer.from("deploy-user:gate-secret-9").toString("base64");
    for (const scheme of ["Basic", "basic"]) {
      const s = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: `${scheme} ${token}` } });
      expect(s.scrub(`${token} | deploy-user:gate-secret-9 | password gate-secret-9 | user deploy-user`)).toBe("••• | ••• | password ••• | user deploy-user");
    }
  });
  test("any scheme in front of a token counts, such as SSWS or ApiKey", () => {
    const okta = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: "SSWS 00okta-token-1" } });
    expect(okta.scrub("key 00okta-token-1")).toBe("key •••");
    const apiKey = SecretScrubber.forProject({ accounts: [], secretHeaders: { "x-auth": "ApiKey live-key-7788" } });
    expect(apiKey.scrub("live-key-7788")).toBe("•••");
  });
  test("a scheme's token too short to mask reliably adds nothing beyond the whole value", () => {
    const short = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: "Bearer abc123" } });
    expect(short.scrub("Bearer abc123 and abc123")).toBe("••• and abc123");
  });
  test("a Basic secret header whose secret is the user, with an empty or short password, masks the user", () => {
    for (const decoded of ["sk_live_abcdef123456:", "FRESHDESK-API-KEY:X"]) {
      const s = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: `Basic ${Buffer.from(decoded).toString("base64")}` } });
      const key = decoded.split(":")[0]!;
      expect(s.scrub(`key ${key} shown`)).toBe("key ••• shown");
    }
  });
  test("a Basic secret header encoded in Latin-1 masks its password too", () => {
    const token = Buffer.from("staging:pässwort-123", "latin1").toString("base64");
    const s = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: `Basic ${token}` } });
    expect(s.scrub("password pässwort-123")).toBe("password •••");
  });
  test("a Basic token that decodes to a value with no colon masks that value too", () => {
    const token = Buffer.from("single-api-secret").toString("base64");
    const s = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: `Basic ${token}` } });
    expect(s.scrub(`${token} and single-api-secret`)).toBe("••• and •••");
  });
  test("a Basic token that is not base64 is masked as it is", () => {
    const s = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: "Basic not-base64-token!" } });
    expect(s.scrub("not-base64-token! alone")).toBe("••• alone");
  });
  test("masks the basic-auth token when it is long enough, even when the password alone is not", () => {
    const s = SecretScrubber.forProject({ accounts: [], httpCredentials: { username: "staging", password: "pw" }, secretHeaders: {} });
    const token = Buffer.from("staging:pw").toString("base64");
    expect(s.scrub(`Basic ${token} and pw`)).toBe("Basic ••• and pw");
  });
});
