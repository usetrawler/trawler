import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BROWSER_TOOLS, openBrowser, type Browser } from "./browser.ts";
import { SecretScrubber } from "./secrets.ts";

const ctx = { toolCallId: "t", messages: [], context: {} };
const PASSWORD = "hunter22-secret";
let server: Server;
let origin = "";
const seenHeaders: Record<string, string | undefined> = {};

const pages: Record<string, string> = {
  "/": `<html><body><h1>Login</h1><img src="https://blocked.example/pixel.png"><input aria-label="Email" type="text"><input aria-label="Password" type="password"><p>Welcome back</p></body></html>`,
  "/echo": `<html><body><p>Your password is ${PASSWORD}</p></body></html>`,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHeaders["x-env"] = req.headers["x-env"] as string | undefined;
    seenHeaders["x-bypass"] = req.headers["x-bypass"] as string | undefined;
    if (req.url === "/gate") {
      const ok = req.headers.authorization === `Basic ${Buffer.from("staging:gate-pass-1").toString("base64")}`;
      res.statusCode = ok ? 200 : 401;
      if (!ok) res.setHeader("www-authenticate", 'Basic realm="staging"');
      res.setHeader("content-type", "text/html");
      res.end(ok ? "<h1>Inside the gate</h1>" : "denied");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(pages[req.url ?? "/"] ?? "<h1>404</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server.close());

async function withBrowser(fn: (b: Browser, blocked: string[], scrubber: SecretScrubber) => Promise<void>, extra: Partial<Parameters<typeof openBrowser>[0]> = {}) {
  const blocked: string[] = [];
  const scrubber = new SecretScrubber();
  scrubber.add(PASSWORD);
  const browser = await openBrowser({ allowedOrigins: [origin], outputDir: mkdtempSync(join(tmpdir(), "trw-")), scrubber, onBlocked: (u) => blocked.push(u), ...extra });
  try {
    await fn(browser, blocked, scrubber);
  } finally {
    await browser.close();
  }
}

async function snapshot(b: Browser): Promise<string> {
  return JSON.stringify(await b.tools.browser_snapshot!.execute!({}, ctx));
}

function refOf(snap: string, label: string): string {
  const ref = new RegExp(`textbox \\\\"${label}\\\\"[^\\n]*?\\[ref=(e\\d+)\\]`).exec(snap)?.[1];
  if (!ref) throw new Error(`no ref for ${label} in ${snap.slice(0, 400)}`);
  return ref;
}

describe("openBrowser", () => {
  test("exposes exactly the browser tools the agent may use, and no evaluate", async () => {
    await withBrowser(async (b) => {
      expect(Object.keys(b.tools).sort()).toEqual([...BROWSER_TOOLS].sort());
      expect(Object.keys(b.tools).some((n) => /evaluate|run_code/.test(n))).toBe(false);
    });
  }, 60_000);

  test("blocks requests to foreign origins, reports them, and the page still works", async () => {
    await withBrowser(async (b, blocked) => {
      await b.tools.browser_navigate!.execute!({ url: origin }, ctx);
      expect(await snapshot(b)).toContain("Welcome back");
      expect(blocked.some((u) => u.startsWith("https://blocked.example"))).toBe(true);
    });
  }, 60_000);

  test("scrubs secrets out of every tool result", async () => {
    await withBrowser(async (b) => {
      await b.tools.browser_navigate!.execute!({ url: `${origin}/echo` }, ctx);
      const snap = await snapshot(b);
      expect(snap).toContain("Your password is •••");
      expect(snap).not.toContain(PASSWORD);
    });
  }, 60_000);

  test("types a password into a password field without echoing it", async () => {
    await withBrowser(async (b) => {
      await b.tools.browser_navigate!.execute!({ url: origin }, ctx);
      const snap = await snapshot(b);
      const user = await b.fillField(refOf(snap, "Email"), "kwame@acme.test", "username");
      const out = await b.fillField(refOf(snap, "Password"), PASSWORD, "password");
      expect(user).not.toMatch(/^failed/);
      expect(out).not.toMatch(/^failed/);
      expect(out).not.toContain(PASSWORD);
      expect(out).toContain("•••");
      expect(await snapshot(b)).toMatch(/textbox \\"Email\\"[^\n]*: kwame@acme\.test/);
    });
  }, 60_000);

  test("reports a failed fill instead of pretending it worked", async () => {
    await withBrowser(async (b) => {
      await b.tools.browser_navigate!.execute!({ url: origin }, ctx);
      expect(await b.fillField("e999", "kwame@acme.test", "username")).toMatch(/^failed: /);
    });
  }, 60_000);

  test("refuses to type a password into a field that is not a password field", async () => {
    await withBrowser(async (b) => {
      await b.tools.browser_navigate!.execute!({ url: origin }, ctx);
      const snap = await snapshot(b);
      const out = await b.fillField(refOf(snap, "Email"), PASSWORD, "password");
      expect(out).toMatch(/^failed: .*not a password field/);
      expect(await snapshot(b)).not.toContain("•••");
    });
  }, 60_000);

  test("refuses to type a password on a page outside the allowed origins", async () => {
    await withBrowser(async (b) => {
      await b.tools.browser_navigate!.execute!({ url: `data:text/html,<input aria-label="Password" type="password">` }, ctx);
      const snap = await snapshot(b);
      const out = await b.fillField(refOf(snap, "Password"), PASSWORD, "password");
      expect(out).toMatch(/^failed: .*not an allowed origin/);
    });
  }, 60_000);

  test("sends basic auth and both plain and secret headers", async () => {
    await withBrowser(
      async (b) => {
        await b.tools.browser_navigate!.execute!({ url: `${origin}/gate` }, ctx);
        expect(await snapshot(b)).toContain("Inside the gate");
        expect(seenHeaders).toEqual({ "x-env": "stg", "x-bypass": "bypass-token-123" });
      },
      { httpCredentials: { username: "staging", password: "gate-pass-1" }, extraHeaders: { "x-env": "stg" }, secretHeaders: { "x-bypass": "bypass-token-123" } },
    );
  }, 60_000);
});
