import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BROWSER_TOOLS, openBrowser, type Browser } from "./browser.ts";
import { SecretScrubber } from "./secrets.ts";
import { newSessionState, ownPasswordTool, type FillField } from "./session-tools.ts";

const ctx = { toolCallId: "t", messages: [], context: {} };
const PASSWORD = "hunter22-secret";
let server: Server;
let foreign: Server;
let second: Server;
let secondOrigin = "";
let origin = "";
let foreignOrigin = "";
const seen: Record<string, IncomingMessage["headers"]> = {};
const foreignHits: string[] = [];
const signups: Array<{ email: string | null; password: string | null; confirm: string | null }> = [];

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
  second = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<html><body><input aria-label="Inner password" type="password"></body></html>`);
  });
  secondOrigin = await listen(second);
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
      case "/short":
        return html(`<form method="post" action="/echo-password"><input aria-label="Password" name="password" type="password" maxlength="12"><button type="submit">Save</button></form>`);
      case "/strip":
        return html(`<form method="post" action="/echo-password"><input aria-label="Password" name="password" type="password" oninput="this.value = this.value.replace(/[^A-Za-z0-9]/g, '')"><button type="submit">Save</button></form>`);
      case "/alert-short":
        return html(`<form method="post" action="/echo-password"><input aria-label="Password" name="password" type="password" oninput="this.value = this.value.slice(0, 12); alert('Checked')"><button type="submit">Save</button></form>`);
      case "/short-on-change":
        return html(`<form method="post" action="/echo-password"><input aria-label="Password" name="password" type="password" onchange="this.value = this.value.slice(0, 12)"><button type="submit">Save</button></form>`);
      case "/js-pin":
        return html(`<input aria-label="PIN" type="password" oninput="this.value = this.value.slice(0, 6)">`);
      case "/js-pin-locked":
        return html(`<input aria-label="PIN" type="password" oninput="this.value = this.value.slice(0, 6); this.disabled = true">`);
      case "/strip-show":
        return html(`<input aria-label="Password" type="password" oninput="this.value = this.value.replace(/[^A-Za-z0-9]/g, '')"><button onclick="const o=document.querySelector('input');const n=document.createElement('input');n.type='text';n.setAttribute('aria-label','Password');n.value=o.value;o.replaceWith(n)">Show password</button>`);
      case "/strip-autoshow":
        return html(`<input aria-label="Password" type="password" oninput="this.value = this.value.replace(/[^A-Za-z0-9]/g, ''); setTimeout(() => { const n = document.createElement('input'); n.type = 'text'; n.setAttribute('aria-label', 'Password'); n.value = this.value; this.replaceWith(n); n.focus(); }, 300)">`);
      case "/placeholder":
        return html(`<p>Forgot password? Change your password below.</p><input aria-label="Password" type="password" value="password" disabled><input aria-label="Search" type="text">`);
      case "/cut-submit":
        return html(`<form method="post" action="/echo-password"><input aria-label="Password" name="password" type="password" oninput="this.value = this.value.slice(0, 6); this.form.submit()"></form>`);
      case "/encode":
        return html(`<input aria-label="Password" type="password"><button onclick="const p = document.querySelector('input'); p.value = btoa(p.value)">Encode</button>`);
      case "/copy-away":
        return html(`<input aria-label="Password" type="password" maxlength="12" oninput="document.getElementById('copy').textContent = 'You typed ' + this.value; this.value = ''; alert('Saved')"><p id="copy"></p>`);
      case "/empties":
        return html(`<input aria-label="Password" type="password" oninput="this.value = ''">`);
      case "/echo-password": {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => html(`<h1>Saved</h1><p>Your password is ${new URLSearchParams(body).get("password")}</p>`));
        return;
      }
      case "/pin":
        return html(`<input aria-label="PIN" type="password" maxlength="6"><button onclick="document.getElementById('echo').textContent = 'Your PIN is ' + document.querySelector('input').value">Echo</button><p id="echo"></p>`);
      case "/signup": {
        if (req.method !== "POST") return html(`<form method="post" action="/signup"><input aria-label="Email" name="email" type="email"><input aria-label="Password" name="password" type="password"><input aria-label="Confirm password" name="confirm" type="password"><button type="submit">Create account</button></form>`);
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const form = new URLSearchParams(body);
          signups.push({ email: form.get("email"), password: form.get("password"), confirm: form.get("confirm") });
          html(`<h1>Welcome</h1><p>Signed up with the password ${form.get("password")}</p>`);
        });
        return;
      }
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
      case "/spec":
        return html(`<p>speculation</p><script type="speculationrules">{"prefetch":[{"source":"list","urls":["${foreignOrigin}/prefetch"]}],"prerender":[{"source":"list","urls":["${foreignOrigin}/prerender"]}]}</script><script>const s=document.createElement("script");s.type="speculationrules";s.textContent=JSON.stringify({prefetch:[{source:"list",urls:["${foreignOrigin}/dyn-prefetch"]}]});document.body.appendChild(s);</script>`);
      case "/spec-header":
        res.setHeader("speculation-rules", '"/rules.json"');
        return html(`<p>speculation header</p>`);
      case "/rules.json":
        res.setHeader("content-type", "application/speculationrules+json");
        return res.end(JSON.stringify({ prefetch: [{ source: "list", urls: [`${foreignOrigin}/header-prefetch`] }] }));
      case "/neuter":
        return html(`<input aria-label="Password" type="password"><button onclick="const p=document.querySelector('input');p.type='text';p.removeAttribute('data-trawler-secret')">Show</button><button onclick="const p=document.querySelector('input');p.type='text';p.removeAttribute('data-trawler-secret');p.value=p.value.slice(0,6)+'X'+p.value.slice(6)">Tamper</button>`);
      case "/remount":
        return html(`<input aria-label="Password" type="password"><button onclick="const o=document.querySelector('input');const n=document.createElement('input');n.type=o.type==='password'?'text':'password';n.setAttribute('aria-label','Password');n.value=o.value;o.replaceWith(n)">Show password</button>`);
      case "/enter":
        return html(`<input aria-label="Password" type="password" onkeydown="if (event.key === 'Enter') document.getElementById('r').textContent = 'submitted'"><p id="r">waiting</p>`);
      case "/alert-login":
        return html(`<input aria-label="Password" type="password"><button onclick="alert(\x27Wrong password\x27)">Sign in</button><button onclick="const p=document.querySelector(\x27input\x27);p.type=\x27text\x27;p.removeAttribute(\x27data-trawler-secret\x27);p.value=p.value.slice(0,6)+\x27X\x27+p.value.slice(6)">Tamper</button>`);
      case "/alert":
        return html(`<button onclick="alert('Saved')">Save</button><p>alert page</p>`);
      case "/shadow":
        return html(`<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<input aria-label="Shadow password" type="password">';</script>`);
      case "/cross-frame":
        return html(`<iframe src="${secondOrigin}/"></iframe>`);
      case "/dialog":
        return html(`<button onclick="document.getElementById('r').textContent = confirm('Sure?') ? 'yes' : 'no'">Delete</button><p id="r">none</p>`);
      case "/upload":
        return html(`<input type="file" aria-label="Avatar"><p>upload page</p>`);
      case "/sw-page":
        return html(`<p id="s">sw?</p><script>const show = (t) => document.getElementById("s").textContent = t; Promise.race([navigator.serviceWorker ? navigator.serviceWorker.register("/sw.js").then(() => "sw registered", () => "sw refused") : Promise.resolve("sw refused"), new Promise((r) => setTimeout(() => r("sw refused"), 1000))]).then(show);</script>`);
      case "/sw.js":
        res.setHeader("content-type", "application/javascript");
        return res.end(`self.addEventListener("install", (e) => e.waitUntil(fetch("${foreignOrigin}/sw-leak").catch(() => {})));`);
      case "/img-redirect":
        return html(`<p>image</p><img src="/redirect-foreign">`);
      case "/sse-page":
        return html(`<p id="s">waiting</p><script>new EventSource("/sse").onmessage = (e) => document.getElementById("s").textContent = "got " + e.data;</script>`);
      case "/sse":
        res.setHeader("content-type", "text/event-stream");
        res.write("data: hello\n\n");
        return;
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
  second.close();
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
  const ref = new RegExp(`(?:textbox|button) \\\\"${label}\\\\"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(snap)?.[1];
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

describe("password fields", () => {
  test("keys cannot be pressed while a password field has focus", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      await b.fillField(refOf(snap, "Password"), PASSWORD, "password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Password"), element: "password" }, ctx);
      for (const key of ["Home", "ArrowRight", "X", "Backspace"]) {
        const out = (await b.tools.browser_press_key!.execute!({ key }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
        expect(out.isError).toBe(true);
        expect(out.content[0]!.text).toMatch(/password field has focus/);
      }
      const after = await snapshot(b);
      expect(after).not.toMatch(/hunter/);
      expect(after).toContain("•••");
    });
  }, 60_000);

  test("keys are refused while a password field inside a shadow root has focus", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/shadow`);
      const snap = await snapshot(b);
      const ref = refOf(snap, "Shadow password");
      expect(await b.fillField(ref, PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: ref, element: "password" }, ctx);
      const out = (await b.tools.browser_press_key!.execute!({ key: "Home" }, ctx)) as { isError?: boolean };
      expect(out.isError).toBe(true);
      expect(await snapshot(b)).not.toMatch(/hunter/);
    });
  }, 60_000);

  test("keys are refused while a password field inside a cross-origin frame has focus", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/cross-frame`);
      await new Promise((r) => setTimeout(r, 300));
      const snap = await snapshot(b);
      const ref = refOf(snap, "Inner password");
      expect(await b.fillField(ref, PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: ref, element: "password" }, ctx);
      for (const key of ["Home", "ArrowRight", "X"]) {
        const out = (await b.tools.browser_press_key!.execute!({ key }, ctx)) as { isError?: boolean };
        expect(out.isError).toBe(true);
      }
      expect(await snapshot(b)).not.toMatch(/hunter/);
    }, { allowedOrigins: [origin, secondOrigin] });
  }, 60_000);

  test("a page that unmarks the password field and makes it plain text still cannot get it edited or read", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/neuter`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Show"), element: "show" }, ctx);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Password"), element: "password" }, ctx);
      for (const key of ["Home", "ArrowRight", "X"]) {
        const out = (await b.tools.browser_press_key!.execute!({ key }, ctx)) as { isError?: boolean };
        expect(out.isError).toBe(true);
      }
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Tamper"), element: "tamper" }, ctx);
      const after = await snapshot(b);
      expect(after).not.toMatch(/hunter|X22|secret/);
    });
  }, 60_000);

  test("a show-password button that swaps in a new field does not let the password be edited", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/remount`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show" }, ctx);
      const shown = await snapshot(b);
      await b.tools.browser_click!.execute!({ target: refOf(shown, "Password"), element: "password" }, ctx);
      for (const key of ["Home", "ArrowRight", "X"]) {
        const out = (await b.tools.browser_press_key!.execute!({ key }, ctx)) as { isError?: boolean };
        expect(out.isError).toBe(true);
      }
      const typed = (await b.tools.browser_type!.execute!({ target: refOf(shown, "Password"), text: "X", element: "password", slowly: true }, ctx)) as { isError?: boolean };
      expect(typed.isError).toBe(true);
      expect(await snapshot(b)).not.toMatch(/hunter|X22|secret/);
    });
  }, 60_000);

  test("a refused password fill leaves the field it was aimed at usable", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Email"), PASSWORD, "password")).toMatch(/^failed: .*not a password field/);
      const typed = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Email"), text: "kwame@acme.test", element: "email" }, ctx)) as { isError?: boolean };
      expect(typed.isError).toBeFalsy();
      const pressed = (await b.tools.browser_press_key!.execute!({ key: "a" }, ctx)) as { isError?: boolean };
      expect(pressed.isError).toBeFalsy();
    });
  }, 60_000);

  test("Enter, Tab and Escape still work on a password field, other keys do not", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/enter`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Password"), element: "password" }, ctx);
      const home = (await b.tools.browser_press_key!.execute!({ key: "Home" }, ctx)) as { isError?: boolean };
      expect(home.isError).toBe(true);
      const enter = (await b.tools.browser_press_key!.execute!({ key: "Enter" }, ctx)) as { isError?: boolean };
      expect(enter.isError).toBeFalsy();
      expect(await snapshot(b)).toContain("submitted");
      const tab = (await b.tools.browser_press_key!.execute!({ key: "Tab" }, ctx)) as { isError?: boolean };
      expect(tab.isError).toBeFalsy();
    });
  }, 60_000);

  test("a key pressed while an alert is open answers at once and the alert can still be closed", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/alert`);
      const snap = await snapshot(b);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Save"), element: "save" }, ctx);
      const started = Date.now();
      const pressed = JSON.stringify(await b.tools.browser_press_key!.execute!({ key: "ArrowDown" }, ctx));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(pressed).toMatch(/dialog/i);
      expect(pressed).not.toMatch(/password field/);
      const handled = (await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx)) as { isError?: boolean };
      expect(handled.isError).toBeFalsy();
      expect(await snapshot(b)).toContain("alert page");
    });
  }, 60_000);

  test("an alert right after signing in does not hang the session", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/alert-login`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      const started = Date.now();
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Sign in"), element: "sign in" }, ctx);
      const pressed = JSON.stringify(await b.tools.browser_press_key!.execute!({ key: "ArrowDown" }, ctx));
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(pressed).toMatch(/dialog/i);
      const handled = (await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx)) as { isError?: boolean };
      expect(handled.isError).toBeFalsy();
      expect(await snapshot(b)).not.toMatch(/hunter/);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Tamper"), element: "tamper" }, ctx);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Password"), element: "password" }, ctx);
      const home = (await b.tools.browser_press_key!.execute!({ key: "Home" }, ctx)) as { isError?: boolean };
      expect(home.isError).toBe(true);
    });
  }, 60_000);

  test("a filled field stays guarded after the page changes its value", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/neuter`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Tamper"), element: "tamper" }, ctx);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Password"), element: "password" }, ctx);
      const out = (await b.tools.browser_press_key!.execute!({ key: "Home" }, ctx)) as { isError?: boolean };
      expect(out.isError).toBe(true);
    });
  }, 60_000);

  test("keys work again once focus leaves the password field", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      await b.fillField(refOf(snap, "Password"), PASSWORD, "password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Email"), element: "email" }, ctx);
      const out = (await b.tools.browser_press_key!.execute!({ key: "a" }, ctx)) as { isError?: boolean };
      expect(out.isError).toBeFalsy();
    });
  }, 60_000);

  test("the model cannot type into a password field", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      const out = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Password"), text: "guess", element: "password" }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/only be filled with sign_in or type_own_password/);
    });
  }, 60_000);

  test("a made-up password reaches a sign-up form's password and confirmation, and never the model", async () => {
    signups.length = 0;
    const scrubber = new SecretScrubber();
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/signup`);
      const snap = await snapshot(b);
      let password = "";
      const fillField: FillField = (ref, text, kind) => ((password = text), b.fillField(ref, text, kind));
      const { type_own_password } = ownPasswordTool({ state: newSessionState([]), fillField, inBrowser: (action) => action(), scrubber });
      await b.tools.browser_type!.execute!({ target: refOf(snap, "Email"), text: "ama@acme.test", element: "email" }, ctx);
      expect(await type_own_password.execute!({ fields: [refOf(snap, "Password"), refOf(snap, "Confirm password")] }, ctx)).toMatch(/^e\d+: typed the password\ne\d+: typed the password$/);
      const guess = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Confirm password"), text: "guess", element: "confirm" }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(guess.isError).toBe(true);
      expect(guess.content[0]!.text).toMatch(/only be filled with sign_in or type_own_password/);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Create account"), element: "Create account" }, ctx);
      const after = await snapshot(b);
      expect(after).toContain("Signed up with the password •••");
      expect(after).not.toContain(password);
      expect(signups).toEqual([{ email: "ama@acme.test", password, confirm: password }]);
      expect(password).toHaveLength(16);
    }, { scrubber });
  }, 60_000);

  for (const [page, kept] of [["/short", "Kx7mPq2Rz9Lw"], ["/strip", "Kx7mPq2Rz9LwAa7"]] as const) {
    test(`a password field that keeps something other than what was typed (${page}) still never shows it`, async () => {
      await withBrowser(async (b) => {
        await navigate(b, `${origin}${page}`);
        const snap = await snapshot(b);
        expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("typed the password");
        const edit = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Password"), text: "x", element: "password" }, ctx)) as { isError?: boolean };
        expect(edit.isError).toBe(true);
        await b.tools.browser_click!.execute!({ target: refOf(snap, "Save"), element: "Save" }, ctx);
        const shown = await snapshot(b);
        expect(shown).toContain("Your password is •••");
        expect(shown).not.toContain(kept);
      });
    }, 60_000);
  }

  test("a password field that takes too few characters to hide a password gets nothing typed into it", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/pin`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "PIN"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("failed: the field takes at most 6 characters, too few to keep a password hidden, so nothing was typed");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Echo"), element: "Echo" }, ctx);
      const shown = await snapshot(b);
      expect(shown).toContain("Your PIN is");
      expect(shown).not.toContain("Kx7mPq");
    });
  }, 60_000);

  test("a password a field shortens behind an alert is hidden once the alert is answered, and after the form is sent", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/alert-short`);
      const snap = await snapshot(b);
      await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password");
      await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Save"), element: "Save" }, ctx);
      const shown = await snapshot(b);
      expect(shown).toContain("Saved");
      expect(shown).not.toContain("Kx7mPq2Rz9Lw");
    });
  }, 60_000);

  test("a made-up password a field shortens only as the form is sent is still hidden on the next page", async () => {
    const scrubber = new SecretScrubber();
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/short-on-change`);
      const snap = await snapshot(b);
      let password = "";
      const fillField: FillField = (ref, text, kind) => ((password = text), b.fillField(ref, text, kind));
      const { type_own_password } = ownPasswordTool({ state: newSessionState([]), fillField, inBrowser: (action) => action(), scrubber });
      await type_own_password.execute!({ fields: [refOf(snap, "Password")] }, ctx);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Save"), element: "Save" }, ctx);
      const shown = await snapshot(b);
      expect(shown).toContain("Your password is •••");
      expect(shown).not.toContain(password.slice(0, 12));
    }, { scrubber });
  }, 60_000);

  test("a field whose script keeps too little of a password to hide is cleared, and says so when it cannot be", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/js-pin`);
      let snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "PIN"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("failed: the field kept too little of the password to hide it, so it was cleared");
      expect(await snapshot(b)).not.toContain("Kx7mPq");
      await navigate(b, `${origin}/js-pin-locked`);
      snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "PIN"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("failed: the field kept too little of the password to hide it, and it could not be cleared");
    });
  }, 60_000);

  test("a rewritten password stays guarded when a show-password button swaps in a plain field holding it", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/strip-show`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show password" }, ctx);
      const shown = await snapshot(b);
      expect(shown).not.toContain("Kx7mPq2Rz9Lw");
      await b.tools.browser_click!.execute!({ target: refOf(shown, "Password"), element: "password" }, ctx);
      const key = (await b.tools.browser_press_key!.execute!({ key: "Backspace" }, ctx)) as { isError?: boolean };
      expect(key.isError).toBe(true);
    });
  }, 60_000);

  test("a rewritten password is guarded from the moment it is typed, before the page swaps the field for a plain one", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/strip-autoshow`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 600));
      const key = (await b.tools.browser_press_key!.execute!({ key: "Backspace" }, ctx)) as { isError?: boolean };
      expect(key.isError).toBe(true);
    });
  }, 60_000);

  test("a placeholder a password field shows is not taken for a password: the page's words stay readable and other fields typeable", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/placeholder`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toMatch(/^failed: /);
      expect(await snapshot(b)).toContain("Forgot password? Change your password below.");
      const search = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Search"), text: "password reset", element: "search" }, ctx)) as { isError?: boolean };
      expect(search.isError).toBeFalsy();
      expect(await snapshot(b)).toContain("Forgot password? Change your password below.");
    });
  }, 60_000);

  test("a password the page shortens and sends before it can be checked is reported as not known to be kept", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/cut-submit`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toMatch(/^failed: /);
    });
  }, 60_000);

  test("a password the page rewrites inside its own field is still hidden", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/encode`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Encode"), element: "Encode" }, ctx);
      const shown = await snapshot(b);
      expect(shown).not.toContain(Buffer.from(PASSWORD).toString("base64"));
      expect(shown).toContain("•••");
    });
  }, 60_000);

  test("a password a shorter maximum cuts is hidden even when the field hands it on and empties before it can be read", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/copy-away`);
      const snap = await snapshot(b);
      await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password");
      await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx);
      const shown = await snapshot(b);
      expect(shown).toContain("You typed •••");
      expect(shown).not.toContain("Kx7mPq2Rz9Lw");
    });
  }, 60_000);

  test("a field that throws away what was typed is reported as not keeping the password", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/empties`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("failed: the field did not keep the password");
    });
  }, 60_000);

  test("typing into ordinary fields still works", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      const out = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Email"), text: "a@b.test", element: "email" }, ctx)) as { isError?: boolean };
      expect(out.isError).toBeFalsy();
      expect(await snapshot(b)).toMatch(/textbox \\"Email\\"[^\n]*: a@b\.test/);
    });
  }, 60_000);
});

describe("robustness", () => {
  test("speculation rules cannot reach foreign origins", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/spec`);
      await new Promise((r) => setTimeout(r, 1500));
      expect(foreignHits.filter((h) => /prefetch|prerender/.test(h))).toEqual([]);
    });
  }, 60_000);

  test("speculation rules announced in a response header cannot reach foreign origins", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/spec-header`);
      await new Promise((r) => setTimeout(r, 1500));
      expect(foreignHits.filter((h) => h.includes("header-prefetch"))).toEqual([]);
    });
  }, 60_000);

  test("once the browser is gone, tools throw instead of returning errors forever", async () => {
    const scrubber = new SecretScrubber();
    const dir = mkdtempSync(join(tmpdir(), "trw-"));
    const b = await openBrowser({ allowedOrigins: [origin], outputDir: dir, scrubber, onBlocked: () => {} });
    try {
      await navigate(b, origin);
      await b.close();
      await expect(b.tools.browser_snapshot!.execute!({}, ctx)).rejects.toThrow(/browser has closed|closed client/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a crashed browser makes every tool throw", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      execFileSync("pkill", ["-9", "-P", String(process.pid), "-f", "chrom"]);
      await new Promise((r) => setTimeout(r, 500));
      await expect(b.tools.browser_snapshot!.execute!({}, ctx)).rejects.toThrow(/browser has closed/);
      await expect(b.tools.browser_click!.execute!({ target: "e1", element: "x" }, ctx)).rejects.toThrow(/browser has closed/);
    });
  }, 60_000);

  test("a sub-resource redirect to a foreign origin is not followed", async () => {
    await withBrowser(async (b) => {
      const before = foreignHits.length;
      await navigate(b, `${origin}/img-redirect`);
      await new Promise((r) => setTimeout(r, 500));
      expect(foreignHits.slice(before).filter((h) => h.startsWith("/stolen"))).toEqual([]);
    });
  }, 60_000);

  test("an unreachable allowed origin gives an error instead of crashing", async () => {
    await withBrowser(async (b) => {
      const out = await navigate(b, "http://127.0.0.1:1/");
      expect(out.isError).toBe(true);
    }, { allowedOrigins: ["http://127.0.0.1:1"] });
  }, 60_000);

  test("streaming responses work and an open stream does not break close", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/sse-page`);
      await b.tools.browser_wait_for!.execute!({ text: "got hello" }, ctx);
      expect(await snapshot(b)).toContain("got hello");
    });
  }, 60_000);
});

describe("page states", () => {
  test("a confirm dialog can be answered instead of locking the session", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/dialog`);
      const snap = await snapshot(b);
      const button = /button \\"Delete\\" \[ref=([a-z0-9]+)\]/.exec(snap)![1]!;
      await b.tools.browser_click!.execute!({ target: button, element: "Delete" }, ctx);
      await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx);
      expect(await snapshot(b)).toContain("yes");
    });
  }, 60_000);

  test("a file chooser can be cancelled but never given local files", async () => {
    await withBrowser(async (b) => {
      const schema = JSON.stringify((b.tools.browser_file_upload!.inputSchema as { jsonSchema: unknown }).jsonSchema);
      expect(schema).not.toContain("paths");
      await navigate(b, `${origin}/upload`);
      const snap = await snapshot(b);
      const ref = /button \\"Avatar\\"[^\n]*?\[ref=([a-z0-9]+)\]/.exec(snap)?.[1] ?? /\[ref=([a-z0-9]+)\][^\n]*Avatar|Avatar[^\n]*\[ref=([a-z0-9]+)\]/.exec(snap)?.slice(1).find(Boolean);
      await b.tools.browser_click!.execute!({ target: ref!, element: "Avatar" }, ctx);
      await b.tools.browser_file_upload!.execute!({ paths: ["/etc/passwd"] }, ctx);
      expect(await snapshot(b)).toContain("upload page");
    });
  }, 60_000);

  test("a service worker cannot reach foreign origins", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/sw-page`);
      await new Promise((r) => setTimeout(r, 1500));
      expect(foreignHits.filter((h) => h.includes("sw-leak"))).toEqual([]);
    });
  }, 60_000);

  test("an action with no page change says what to do next", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      const out = JSON.stringify(await b.tools.browser_type!.execute!({ target: refOf(snap, "Email"), text: "x", element: "email" }, ctx));
      expect(out).toContain("Call browser_snapshot to see the page");
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
