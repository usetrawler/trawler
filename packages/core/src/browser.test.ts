import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BROWSER_TOOLS, openBrowser, type Browser } from "./browser.ts";
import { SecretScrubber } from "./secrets.ts";

const ctx = { toolCallId: "t", messages: [], context: {} };
const PASSWORD = "hunter22-secret";
let server: Server;
let foreign: Server;
let origin = "";
let foreignOrigin = "";
const seen: Record<string, IncomingMessage["headers"]> = {};
const foreignHits: string[] = [];

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => {
    const addr = s.address();
    r(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
  }));
}

beforeAll(async () => {
  foreign = createServer((req, res) => {
    foreignHits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end("<h1>Foreign page</h1>");
  });
  foreign.on("upgrade", (req, socket) => {
    foreignHits.push(`ws:${req.url}`);
    socket.destroy();
  });
  foreignOrigin = await listen(foreign);
  server = createServer((req, res) => {
    seen[req.url ?? ""] = req.headers;
    const html = (body: string) => {
      res.setHeader("content-type", "text/html");
      res.end(`<html><body>${body}</body></html>`);
    };
    switch (req.url) {
      case "/":
        return html(`<h1>Login</h1><img src="https://blocked.example/pixel.png"><img src="https://blocked.example/other.png"><input aria-label="Email" type="text"><input aria-label="Password" type="password"><p>Welcome back</p><a href="/two">Next page</a>`);
      case "/two":
        return html(`<h1>Second page</h1>`);
      case "/echo":
        return html(`<p>Your password is ${PASSWORD}</p>`);
      case "/frame":
        return html(`<iframe src="data:text/html,<input aria-label='Password' type='password'>"></iframe>`);
      case "/redirect-foreign":
        res.statusCode = 302;
        res.setHeader("location", `${foreignOrigin}/stolen?token=abc`);
        return res.end();
      case "/redirect-local":
        res.statusCode = 302;
        res.setHeader("location", "/two");
        return res.end();
      case "/ws":
        return html(`<p id="s">connecting</p><script>const w = new WebSocket("${foreignOrigin.replace("http", "ws")}/sock"); w.onerror = () => document.getElementById("s").textContent = "socket refused";</script>`);
      case "/cookie":
        return html(`<p>cookie=${req.headers.cookie ?? "none"}</p>`);
      case "/gate": {
        const ok = req.headers.authorization === `Basic ${Buffer.from("staging:gate-pass-1").toString("base64")}`;
        res.statusCode = ok ? 200 : 401;
        if (!ok) res.setHeader("www-authenticate", 'Basic realm="staging"');
        return ok ? html("<h1>Inside the gate</h1>") : res.end("denied");
      }
      default:
        res.statusCode = 404;
        return html("<h1>404</h1>");
    }
  });
  origin = await listen(server);
});
afterAll(() => {
  server.close();
  foreign.close();
});

async function withBrowser(fn: (b: Browser, blocked: string[], dir: string) => Promise<void>, extra: Partial<Parameters<typeof openBrowser>[0]> = {}) {
  const blocked: string[] = [];
  const scrubber = new SecretScrubber();
  scrubber.add(PASSWORD);
  const dir = mkdtempSync(join(tmpdir(), "trw-"));
  const browser = await openBrowser({ allowedOrigins: [origin], outputDir: dir, scrubber, onBlocked: (u) => blocked.push(u), ...extra });
  try {
    await fn(browser, blocked, dir);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const navigate = (b: Browser, url: string) => b.tools.browser_navigate!.execute!({ url }, ctx) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const snapshot = async (b: Browser) => JSON.stringify(await b.tools.browser_snapshot!.execute!({}, ctx));

function refOf(snap: string, label: string): string {
  const ref = new RegExp(`textbox \\\\"${label}\\\\"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(snap)?.[1];
  if (!ref) throw new Error(`no ref for ${label} in ${snap.slice(0, 400)}`);
  return ref;
}

describe("tools", () => {
  test("exposes exactly the browser tools the agent may use, and no evaluate", async () => {
    await withBrowser(async (b) => {
      expect(Object.keys(b.tools).sort()).toEqual([...BROWSER_TOOLS].sort());
      expect(Object.keys(b.tools).some((n) => /evaluate|run_code|screenshot/.test(n))).toBe(false);
    });
  }, 60_000);

  test("the snapshot tool cannot write files", async () => {
    await withBrowser(async (b) => {
      const schema = JSON.stringify((b.tools.browser_snapshot!.inputSchema as { jsonSchema: unknown }).jsonSchema);
      expect(schema).not.toContain("filename");
      await navigate(b, origin);
      expect(existsSync("agent-wrote.yml")).toBe(false);
      try {
        const out = await b.tools.browser_snapshot!.execute!({ filename: "agent-wrote.yml" }, ctx);
        expect(JSON.stringify(out)).toContain("Welcome back");
        expect(existsSync("agent-wrote.yml")).toBe(false);
      } finally {
        rmSync("agent-wrote.yml", { force: true });
      }
    });
  }, 60_000);

  test("scrubs secrets out of every tool result", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/echo`);
      const snap = await snapshot(b);
      expect(snap).toContain("Your password is •••");
      expect(snap).not.toContain(PASSWORD);
    });
  }, 60_000);

  test("actions return the page, not a snapshot file link", async () => {
    await withBrowser(async (b, _blocked, dir) => {
      const out = JSON.stringify(await navigate(b, origin));
      expect(out).toContain(origin);
      expect(out).not.toMatch(/\.yml/);
      expect(existsSync(dir) ? (await import("node:fs")).readdirSync(dir).filter((f) => f.endsWith(".yml")) : []).toEqual([]);
    });
  }, 60_000);
});

describe("origin allowlist", () => {
  test("blocks foreign sub-resources, reports each origin once, and the page still works", async () => {
    await withBrowser(async (b, blocked) => {
      await navigate(b, origin);
      expect(await snapshot(b)).toContain("Welcome back");
      await navigate(b, origin);
      expect(blocked.filter((u) => u.startsWith("https://blocked.example"))).toHaveLength(1);
    });
  }, 60_000);

  test("refuses to navigate to javascript:, data: or foreign URLs", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      for (const url of ["javascript:document.title='pwned'", "data:text/html,<h1>x</h1>", `${foreignOrigin}/direct`]) {
        const out = await navigate(b, url);
        expect(out.isError).toBe(true);
        expect(out.content[0]!.text).toMatch(/Only http\(s\) addresses on the allowed origins/);
      }
      expect(await snapshot(b)).not.toContain("pwned");
      expect(foreignHits).not.toContain("/direct");
    });
  }, 60_000);

  test("does not follow a server redirect to a foreign origin, and says so", async () => {
    await withBrowser(async (b, blocked) => {
      const out = JSON.stringify(await navigate(b, `${origin}/redirect-foreign`));
      expect(foreignHits.some((h) => h.startsWith("/stolen"))).toBe(false);
      expect(blocked.some((u) => u.startsWith(foreignOrigin))).toBe(true);
      expect(out).toContain("outside the allowed origins");
    });
  }, 60_000);

  test("follows a redirect within the allowed origin", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/redirect-local`);
      expect(await snapshot(b)).toContain("Second page");
    });
  }, 60_000);

  test("blocks WebSockets to foreign origins", async () => {
    await withBrowser(async (b, blocked) => {
      await navigate(b, `${origin}/ws`);
      await b.tools.browser_wait_for!.execute!({ text: "socket refused" }, ctx);
      expect(foreignHits.some((h) => h.startsWith("ws:"))).toBe(false);
      expect(blocked.some((u) => u.startsWith("ws://"))).toBe(true);
    });
  }, 60_000);
});

describe("fillField", () => {
  test("types a username and a password without echoing the password", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Email"), "kwame@acme.test", "username")).toBe("typed the username");
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      expect(await snapshot(b)).toMatch(/textbox \\"Email\\"[^\n]*: kwame@acme\.test/);
    });
  }, 60_000);

  test("reports why a fill failed", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      expect(await b.fillField("e999", "kwame@acme.test", "username")).toMatch(/^failed: [\s\S]*e999/);
      expect(await b.fillField("e999", PASSWORD, "password")).toMatch(/^failed: [\s\S]*e999/);
    });
  }, 60_000);

  test("refuses to type a password into a field that is not a password field", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Email"), PASSWORD, "password")).toMatch(/^failed: .*not a password field/);
      expect(await snapshot(b)).not.toContain("•••");
    });
  }, 60_000);

  test("refuses to type a password into a field whose frame is not an allowed origin", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/frame`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toMatch(/^failed: .*not an allowed origin/);
    });
  }, 60_000);
});

describe("context", () => {
  test("sends basic auth and both plain and secret headers", async () => {
    await withBrowser(
      async (b) => {
        await navigate(b, `${origin}/gate`);
        expect(await snapshot(b)).toContain("Inside the gate");
        expect(seen["/gate"]).toMatchObject({ "x-env": "stg", "x-bypass": "bypass-token-123" });
      },
      { httpCredentials: { username: "staging", password: "gate-pass-1" }, extraHeaders: { "x-env": "stg" }, secretHeaders: { "x-bypass": "bypass-token-123" } },
    );
  }, 60_000);

  test("starts from a saved storage state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trw-state-"));
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ cookies: [{ name: "session", value: "abc123", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }));
    try {
      await withBrowser(async (b) => {
        await navigate(b, `${origin}/cookie`);
        expect(await snapshot(b)).toContain("cookie=session=abc123");
      }, { storageState: file });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
