import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser as PlaywrightBrowser } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BROWSER_TOOLS, openBrowser, type Browser, type Screenshot } from "./browser.ts";
import { MIN_SECRET_LENGTH, SecretScrubber } from "./secrets.ts";
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
const pacedHits: number[] = [];

const MOTIONS: Record<string, string> = {
  keyframes: `echo.className = "fly"`,
  waapi: `echo.animate([{ transform: "translateY(0)" }, { transform: "translateY(300px)" }], { duration: 200, iterations: Infinity, direction: "alternate" })`,
  transition: `echo.style.transition = "transform .2s linear"; let low = false; const flip = () => { low = !low; echo.style.transform = low ? "translateY(300px)" : "translateY(0)"; }; flip(); setInterval(flip, 200)`,
  "frame-clock": `const t0 = performance.now(); const step = (t) => { echo.style.transform = "translateY(" + (150 + 150 * Math.sin((t - t0) / 30)) + "px)"; requestAnimationFrame(step); }; requestAnimationFrame(step)`,
  "wall-clock": `const t0 = performance.now(); const step = () => { echo.style.transform = "translateY(" + (150 + 150 * Math.sin((performance.now() - t0) / 30)) + "px)"; requestAnimationFrame(step); }; requestAnimationFrame(step)`,
};

function moving(motion: string): string {
  return `<style>body{margin:0;font:20px monospace} #echo{position:absolute;top:80px;left:20px;margin:0;color:#ff0000} @keyframes fly{from{transform:translateY(0)}to{transform:translateY(300px)}} .fly{animation:fly .2s linear infinite alternate}</style><input aria-label="Password" type="password" oninput="document.getElementById('echo').textContent = this.value"><button onclick="const echo = document.getElementById('echo'); ${MOTIONS[motion]!.replace(/"/g, "&quot;")}">Move</button><p id="echo"></p>`;
}

function narrowColumn(inner: string): string {
  return `<div style="width:120px;font:16px sans-serif"><p>Account</p><p>Plan: Team</p>${inner}<p>Billing: monthly</p><p>Seats: 5</p><p>Region: EU</p></div>`;
}

function card(c: { heading: string; name: string; secret: string }): string {
  return `<div style="font:20px sans-serif;padding:16px;border:1px solid #999;width:640px"><h2>${c.heading}</h2><span>Password: </span><span style="color:#ff0000">${c.secret}</span><p>Plan: Team</p><label>Name <input aria-label="Name" value="${c.name}"></label></div>`;
}

function closedCard(light: string, shadow: string): string {
  return `<closed-card style="display:block;font:20px monospace;color:#ff0000">${light}</closed-card><p>Plan: Team</p><script>customElements.define("closed-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = ${JSON.stringify(shadow)}; } });</script>`;
}

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
      res.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    switch (req.url) {
      case "/paced":
        pacedHits.push(Date.now());
        return html(`<p>Paced</p>`);
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
      case "/closing-frame":
        return html(`<iframe src="/closing-frame-field"></iframe>`);
      case "/closing-frame-field":
        return html(`<input aria-label="Password" type="password" oninput="parent.document.querySelector('iframe').remove()">`);
      case "/encode":
        return html(`<input aria-label="Password" type="password"><button onclick="const p = document.querySelector('input'); p.value = btoa(p.value)">Encode</button>`);
      case "/copy-away":
        return html(`<input aria-label="Password" type="password" maxlength="12" oninput="document.getElementById('copy').textContent = 'You typed ' + this.value; this.value = ''; alert('Saved')"><p id="copy"></p>`);
      case "/empties":
        return html(`<input aria-label="Password" type="password" oninput="this.value = ''">`);
      case "/reset-to-placeholder":
        return html(`<input aria-label="Password" type="password"><button onclick="document.querySelector('input').value = 'password'">Reset</button>`);
      case "/space-out":
        return html(`<form method="post" action="/echo-password"><input aria-label="Password" name="password" type="password"><button type="button" onclick="const p = document.querySelector('input'); p.value = p.value.split('').join(' ')">Space out</button><button type="submit">Save</button></form>`);
      case "/echo-password": {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => html(`<h1>Saved</h1><p>Your password is ${new URLSearchParams(body).get("password")}</p>`));
        return;
      }
      case "/password-placeholder":
        return html(`<input aria-label="Password" type="password" placeholder="Enter your password">`);
      case "/password-colon-label":
        return html(`<input aria-label="Password: at least 4 characters" type="password">`);
      case "/signed-in-as-long":
        return html(`<p>ad min-secret</p><input aria-label="Password" type="password">`);
      case "/password-shouted":
        return html(`<input aria-label="Password" type="password" oninput="this.value = this.value.toUpperCase()">`);
      case "/password-shown-as-search":
        return html(`<input aria-label="Password" type="password"><button onclick="document.querySelector('input').type = 'search'">Show password</button>`);
      case "/password-copied":
        return html(`<input aria-label="Your password" type="text" value=" ad  min-secret">`);
      case "/signed-in-as":
        return html(`<p>admin</p><input aria-label="Password" type="password">`);
      case "/readonly-password":
        return html(`<input aria-label="Password" type="password" readonly>`);
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
      case "/opens-alerting-popup":
        return html(`<h1>Main</h1><a href="/alerts-on-load" target="_blank">Open popup</a><a href="/plain">Plain</a>`);
      case "/search-and-alerting-popup":
        return html(`<input aria-label="Search" type="search"><a href="/alerts-on-load" target="_blank">Open popup</a>`);
      case "/opens-alerting-window":
        return html(`<h1>Main</h1><button onclick="window.open('/alerts-on-load')">Sign in with a popup</button>`);
      case "/password-and-alerting-popup":
        return html(`<input aria-label="Password" type="password"><a href="/alerts-on-load" target="_blank">Open popup</a>`);
      case "/alerts-on-load":
        return html(`<script>alert("from popup")</script>`);
      case "/unsaved-edit":
        return html(`<h1>Edit venture</h1><a href="/plain">Back to list</a><button onclick="alert('Saved!')">Save</button><script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; });</script>`);
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
      case "/text-a":
        return html(`<h1>Invoice 1001</h1>`);
      case "/text-b":
        return html(`<h1>Invoice 2002</h1>`);
      case "/frame-remount":
        return html(`<iframe src="/remount" style="width:640px;height:160px;border:0"></iframe>`);
      case "/echo-upper":
        return html(`<input aria-label="Password" type="password" oninput="document.getElementById('echo').textContent = this.value.toUpperCase()"><p>Saved as <b id="echo"></b> for you.</p>`);
      case "/echo-inline":
        return html(`<input aria-label="Password" type="password" oninput="document.getElementById('echo').textContent = this.value"><p>You typed <b id="echo"></b> just now.</p>`);
      case "/echo-encoded-a":
        return html(`<p>Posted to /login?password=Alpha%26Secret%231111</p>`);
      case "/echo-encoded-b":
        return html(`<p>Posted to /login?password=Bravo%26Secret%232222</p>`);
      case "/toast":
        return html(`<style>@keyframes fade{from{opacity:1}to{opacity:.9}} #toast{animation:fade 3s forwards}</style><p id="toast" onanimationend="this.remove()">Could not save: error 500</p>`);
      case "/api-key-a":
        return html(`<p>API key: sk-live-first-1</p><input aria-label="Key" value="sk-live-first-1"><input aria-label="Hint" placeholder="sk-live-first-1">`);
      case "/api-key-b":
        return html(`<p>API key: sk-live-other-2</p><input aria-label="Key" value="sk-live-other-2"><input aria-label="Hint" placeholder="sk-live-other-2">`);
      case "/swap-echo":
        return html(`<input aria-label="Password" type="password"><button onclick="const p = document.querySelector('input'); p.value = p.value.slice(0, -1) + 'X'; document.getElementById('echo').textContent = p.value">Swap</button><p id="echo"></p>`);
      case "/password-keeps-changing":
        return html(`<input aria-label="Password" type="password"><button onclick="const p = document.querySelector('input'); p.value = p.value + 'x'">Change</button>`);
      case "/password-fancy":
        return html(`<input aria-label="Password" type="password"><button onclick="const p = document.querySelector('input'); window.n = (window.n || 0) + 1; p.value = p.value.slice(0, 14) + ' ' + window.n + '  &quot;\\x27&amp;\\\\é\\u200b<'.repeat(60)">Change</button>`);
      case "/password-long-before":
        return html(`<input aria-label="Password" type="password" value="${"x".repeat(1500)}" oninput="clearTimeout(window.back); window.back = setTimeout(() => { this.value = '${"x".repeat(1500)}'; document.getElementById('state').textContent = 'Back'; }, 300)"><p id="state">Waiting</p>`);
      case "/password-grows":
        return html(`<input aria-label="Password" type="password" oninput="clearTimeout(window.grow); window.grow = setTimeout(() => { this.value = this.value + 'x'.repeat(2000); document.getElementById('state').textContent = 'Grown'; }, 300)"><p id="state">Waiting</p>`);
      case "/password-lone-surrogate":
        return html(`<input aria-label="Password" type="password" oninput="clearTimeout(window.odd); window.odd = setTimeout(() => { this.value = this.value + '\\uD800'; document.getElementById('echo').textContent = this.value; document.getElementById('state').textContent = 'Odd'; }, 300)"><p id="echo"></p><p id="state">Waiting</p>`);
      case "/swap-later-slow":
        return html(`<input aria-label="Password" type="password" oninput="clearTimeout(window.swap); window.swap = setTimeout(() => { const p = this; p.value = p.value.slice(0, -1) + 'X'; document.getElementById('echo').textContent = p.value; document.getElementById('state').textContent = 'Swapped'; const real = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); Object.defineProperty(p, 'value', { get() { const until = Date.now() + 900; while (Date.now() < until) {} return real.get.call(this); }, set(v) { real.set.call(this, v); } }); }, 300)"><p id="echo"></p><p id="state">Waiting</p>`);
      case "/swap-later-throws":
        return html(`<input aria-label="Password" type="password" oninput="clearTimeout(window.swap); window.swap = setTimeout(() => { const p = this; p.value = p.value.slice(0, -1) + 'X'; document.getElementById('echo').textContent = p.value; document.getElementById('state').textContent = 'Swapped'; const real = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); Object.defineProperty(p, 'value', { get() { throw new Error('no'); }, set(v) { real.set.call(this, v); } }); Object.defineProperty(HTMLInputElement.prototype, 'value', { get() { throw new Error('no'); }, set(v) { real.set.call(this, v); }, configurable: true }); }, 300)"><p id="echo"></p><p id="state">Waiting</p>`);
      case "/swap-later-own-getter":
        return html(`<input aria-label="Password" type="password" oninput="clearTimeout(window.swap); window.swap = setTimeout(() => { const p = this; p.value = p.value.slice(0, -1) + 'X'; document.getElementById('echo').textContent = p.value; document.getElementById('state').textContent = 'Swapped'; const real = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); Object.defineProperty(p, 'value', { get() { throw new Error('no'); }, set(v) { real.set.call(this, v); } }); }, 300)"><p id="echo"></p><p id="state">Waiting</p>`);
      case "/swap-later-lies":
        return html(`<input aria-label="Password" type="password" oninput="clearTimeout(window.swap); window.swap = setTimeout(() => { const p = this; const typed = p.value; p.value = p.value.slice(0, -1) + 'X'; document.getElementById('echo').textContent = p.value; document.getElementById('state').textContent = 'Swapped'; const real = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); Object.defineProperty(HTMLInputElement.prototype, 'value', { get() { return typed; }, set(v) { real.set.call(this, v); }, configurable: true }); }, 300)"><p id="echo"></p><p id="state">Waiting</p>`);
      case "/swap-then-two-alerts":
        return html(`<input aria-label="Password" type="password"><button onclick="const p = document.querySelector('input'); p.value = p.value.slice(0, -1) + 'X'; alert('first'); alert('Your password: ' + p.value)">Check</button>`);
      case "/swap-then-alert":
        return html(`<input aria-label="Password" type="password"><button onclick="const p = document.querySelector('input'); p.value = p.value.slice(0, -1) + 'X'; alert('Your password: ' + p.value)">Check</button>`);
      case "/reveal-clear":
        return html(`<input aria-label="Password" type="password"><button onclick="const o=document.querySelector('input');const n=document.createElement('input');n.type='text';n.setAttribute('aria-label','Password');n.value=o.value;o.replaceWith(n)">Show password</button><button onclick="document.querySelector('input').value=''">Clear</button>`);
      case "/moving-keyframes":
      case "/moving-waapi":
      case "/moving-transition":
      case "/moving-frame-clock":
      case "/moving-wall-clock":
        return html(moving(req.url.slice("/moving-".length)));
      case "/churn":
        return html(`<div id="top" style="height:30px"></div><input aria-label="Other" style="width:200px"><input aria-label="Password" type="password"><button onclick="const o = document.querySelector('input[type=password]'); const n = document.createElement('input'); n.setAttribute('aria-label', 'Password'); n.style.cssText = 'width:600px;font:20px monospace;color:#ff0000'; n.value = o.value; o.replaceWith(n); setInterval(() => { const top = document.getElementById('top'); if (top.firstChild) top.firstChild.remove(); else top.append(document.createElement('input')); }, 4)">Show password</button>`);
      case "/hidden-value":
        return html(`<input aria-label="Password" type="password"><button onclick="const o = document.querySelector('input'); const n = document.createElement('input'); n.setAttribute('aria-label', 'Password'); n.style.cssText = 'width:600px;font:20px monospace'; n.value = o.value; o.replaceWith(n); Object.defineProperty(n, 'value', { get: () => '' })">Show password</button>`);
      case "/card":
        return html(card({ heading: "Account settings", name: "Ana", secret: "card-secret-1111" }));
      case "/card-other-heading":
        return html(card({ heading: "Billing overview", name: "Ana", secret: "card-secret-1111" }));
      case "/card-other-field":
        return html(card({ heading: "Account settings", name: "Bea", secret: "card-secret-1111" }));
      case "/overflowing":
      case "/overflowing-other":
        return html(`<h1>${req.url === "/overflowing" ? "Settings" : "Preferences"}</h1><div style="font:20px sans-serif;padding:16px;border:1px solid #999;width:640px"><h2>Account settings</h2><p style="width:80px;white-space:nowrap;color:#ff0000">card-secret-1111 is the key</p><p>Plan: Team</p></div>`);
      case "/tight-line":
        return html(`<p style="font:20px monospace;line-height:0;color:#ff0000">card-secret-1111</p><p>Plan: Team</p><p>Billing: monthly</p>`);
      case "/tight-height":
        return html(`<p style="font:20px monospace;height:13px;margin:0;color:#ff0000">card-secret-1111</p><p>Plan: Team</p><p>Billing: monthly</p>`);
      case "/tight-width":
        return html(`<p id="secret" style="font:20px monospace;white-space:nowrap;color:#ff0000">card-secret-1111</p><p>Plan: Team</p><script>const text = document.createRange(); text.selectNodeContents(document.getElementById("secret")); document.getElementById("secret").style.width = (text.getBoundingClientRect().width - 8) + "px";</script>`);
      case "/clip-one-axis":
        return html(`<div style="height:32px;overflow-x:clip;width:220px;font:20px/24px monospace;color:#ff0000">first-line card-secret-1111</div><p>Plan: Team</p><p>Billing: monthly</p>`);
      case "/contents-hidden":
        return html(narrowColumn(`<div style="display:contents;overflow:hidden"><p style="width:80px;white-space:nowrap;font:20px monospace;color:#ff0000">card-secret-1111 is here</p></div>`));
      case "/inline-hidden":
        return html(narrowColumn(`<p style="width:100px"><a href="#" style="overflow:hidden"><span style="display:inline-block;width:80px;white-space:nowrap;font:20px monospace;color:#ff0000">card-secret-1111 is here</span></a></p>`));
      case "/clip-margin":
        return html(narrowColumn(`<div style="width:90px;overflow:clip;overflow-clip-margin:200px;white-space:nowrap;font:20px monospace;color:#ff0000">card-secret-1111 and more</div>`));
      case "/moves-when-masked":
        return html(`<p id="echo" style="font:20px monospace;color:#ff0000">card-secret-1111</p><script>new MutationObserver((records) => { if (records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1))) document.getElementById("echo").style.transform = "translateY(120px)"; }).observe(document.documentElement, { childList: true });</script>`);
      case "/collapsed":
      case "/collapsed-plain":
        return html(`<p>Keys</p><div style="max-height:0;overflow:hidden"><p style="font:20px monospace;color:#ff0000">Your key is ${req.url === "/collapsed" ? "card-secret-1111" : "not-a-secret-00"}</p></div><p style="font:20px monospace;color:#0000ff">Plan: Team, billed monthly</p>`);
      case "/select-list":
        return html(`<select size="3" style="font:20px monospace;color:#ff0000;width:300px"><option>first</option><option>card-secret-1111</option><option>third</option></select><p>Plan: Team</p>`);
      case "/select-closed":
        return html(`<select style="font:20px monospace;color:#ff0000;width:300px"><option selected>card-secret-1111</option><option>other</option></select><p>Plan: Team</p>`);
      case "/broken-image":
        return html(`<img alt="card-secret-1111" src="https://blocked.example/key.png" style="font:20px monospace;color:#ff0000"><p>Plan: Team</p>`);
      case "/slow-steps":
        return html(`<style>@keyframes hop{from{transform:translateX(0)}to{transform:translateX(200px)}} #echo{display:inline-block;animation:hop 20s steps(2) infinite}</style><p style="font:20px monospace;color:#ff0000">Key: <span id="echo">card-secret-1111</span></p>`);
      case "/glowing-field":
        return html(`<style>@keyframes glow{from{box-shadow:0 0 0 #09f}to{box-shadow:0 0 12px #09f}} input{animation:glow 1s infinite alternate}</style><input aria-label="Password" type="password" value="field-secret-1">`);
      case "/row-hidden":
        return html(narrowColumn(`<table style="font:20px monospace"><tr style="overflow:hidden"><td>Key</td><td style="max-width:40px;white-space:nowrap;color:#ff0000">card-secret-1111 is the key</td></tr><tr><td>Plan</td><td>Team</td></tr></table>`));
      case "/row-span":
        return html(`<table style="font:20px monospace"><tr style="overflow:hidden"><td>Key</td><td rowspan="3" style="vertical-align:bottom;color:#ff0000">card-secret-1111</td></tr><tr><td>Row two</td></tr><tr><td>Row three</td></tr></table>`);
      case "/closed-details":
      case "/closed-details-plain":
        return html(`<details><summary style="font:20px monospace;color:#0000ff">Show the key</summary><p style="font:20px monospace;color:#ff0000">${req.url === "/closed-details" ? "card-secret-1111" : "not-a-secret-00"}</p></details><p>Plan: Team</p>`);
      case "/contents-text":
        return html(`<p style="font:20px monospace;color:#ff0000">Key: <span style="display:contents">card-secret-1111</span> for the API</p><p>Plan: Team</p>`);
      case "/slot-fallback":
        return html(`<key-card></key-card><p>Plan: Team</p><script>customElements.define("key-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<p style="font:20px monospace;color:#ff0000"><slot>card-secret-1111</slot></p>'; } });</script>`);
      case "/flicker-container":
        return html(`<style>@keyframes hop{from{transform:translateX(0)}to{transform:translateX(200px)}} #box{animation:hop 20s steps(2) infinite}</style><div id="box"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div>`);
      case "/shaking-field":
        return html(`<style>@keyframes hop{from{transform:translateX(0)}to{transform:translateX(200px)}} input{animation:hop 20s steps(2) infinite}</style><input aria-label="Password" type="password" value="field-secret-1">`);
      case "/scroll-driven":
        return html(`<style>@keyframes rise{from{transform:translateY(20px)}to{transform:translateY(0)}} #box{animation:rise linear both;animation-timeline:scroll(root)}</style><div id="box"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div><div style="height:2000px"></div>`);
      case "/hidden-parent-split":
        return html(`<div style="visibility:hidden;font:20px monospace;color:#ff0000">card-sec<span style="visibility:visible">ret-1111</span> and more</div><p>Plan: Team</p>`);
      case "/animated-child":
        return html(`<style>@keyframes hop{from{transform:translateY(0)}to{transform:translateY(120px)}} b{display:inline-block;animation:hop 20s steps(2) infinite}</style><p style="font:20px monospace;color:#ff0000">card-sec<b>ret-1111</b></p>`);
      case "/delayed-animation":
        return html(`<style>@keyframes slide{from{transform:translateX(0)}to{transform:translateX(200px)}} #box{animation:slide 1s 60s}</style><div id="box"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div>`);
      case "/timer-animation":
        return html(`<div id="box"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div><script>document.getElementById("box").animate([], { duration: 60000 });</script>`);
      case "/rounded-animation":
        return html(`<style>@keyframes morph{from{border-radius:0}to{border-radius:24px}} #box{background:#eee;animation:morph 400ms infinite alternate}</style><div id="box"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div>`);
      case "/badge-beside":
        return html(`<style>@keyframes bounce{from{transform:translateY(0)}to{transform:translateY(-6px)}} .badge{display:inline-block;animation:bounce 400ms infinite alternate}</style><p style="font:20px monospace;color:#ff0000">Key: <span>card-secret-1111</span> <span class="badge" style="color:#333">NEW</span></p><p>Plan: Team</p>`);
      case "/icon-inside":
        return html(`<style>@keyframes spin{to{transform:rotate(360deg)}} .icon{display:inline-block;width:12px;height:12px;border:2px solid #333;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite}</style><p style="font:20px monospace;color:#ff0000">Key: card-secret-1111 <span class="icon"></span></p><p>Plan: Team</p>`);
      case "/shadow-split":
        return html(`<split-key style="visibility:hidden;font:20px monospace;color:#ff0000">card-sec</split-key><p>Plan: Team</p><script>customElements.define("split-key", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<slot></slot><span style="visibility:visible">ret-1111</span>'; } });</script>`);
      case "/shadow-split-nested":
        return html(`<div style="visibility:hidden;font:20px monospace;color:#ff0000">card-sec<split-tail></split-tail> and more</div><p>Plan: Team</p><script>customElements.define("split-tail", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<span style="visibility:visible">ret-1111</span>'; } });</script>`);
      case "/shadow-text":
      case "/shadow-lit":
      case "/shadow-groups": {
        const inner = { "/shadow-text": "card-secret-1111", "/shadow-lit": "<!--?lit$1$-->card-secret-1111<!---->", "/shadow-groups": "<span>card-</span><span>secret-</span><span>1111</span>" }[req.url];
        return html(`<key-view></key-view><p>Plan: Team</p><script>customElements.define("key-view", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<style>:host{display:block;font:20px monospace;color:#ff0000}</style>${inner}'; } });</script>`);
      }
      case "/shadow-split-apart":
        return html(`<div style="height:160px"><split-apart style="font:20px monospace;color:#ff0000">card-sec</split-apart></div><p>Plan: Team</p><script>customElements.define("split-apart", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<style>:host{display:block;height:24px}</style><slot></slot><div style="margin:80px 0 0 200px">ret-1111</div>'; } });</script>`);
      case "/shadow-escaping-part":
        return html(`<div style="position:relative;height:260px"><escaping-part style="display:block;overflow:hidden;height:24px;font:20px monospace;color:#ff0000">card-sec</escaping-part></div><p>Plan: Team</p><script>customElements.define("escaping-part", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<slot></slot><span style="position:absolute;left:300px;top:200px">ret-1111</span>'; } });</script>`);
      case "/escaping-part":
        return html(`<div style="position:relative;height:260px"><div style="overflow:hidden;height:24px;font:20px monospace;color:#ff0000">card-sec<span style="position:absolute;left:300px;top:200px">ret-1111</span></div></div><p>Plan: Team</p>`);
      case "/slotted-escaping":
        return html(`<div style="position:relative;height:260px"><slotted-away style="display:block;overflow:hidden;height:24px;font:20px monospace;color:#ff0000">card-secret-1111</slotted-away></div><p>Plan: Team</p><script>customElements.define("slotted-away", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<div style="position:absolute;left:300px;top:200px"><slot></slot></div>'; } });</script>`);
      case "/shadow-slot-after":
        return html(`<slot-after style="display:block;font:20px monospace;color:#ff0000">ret-1111</slot-after><p>Plan: Team</p><script>customElements.define("slot-after", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "card-sec<slot></slot>"; } });</script>`);
      case "/shadow-slot-named":
        return html(`<slot-named style="display:block;font:20px monospace;color:#ff0000"><span slot="tail">ret-1111</span></slot-named><p>Plan: Team</p><script>customElements.define("slot-named", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = 'card-sec<slot name="tail"></slot>'; } });</script>`);
      case "/shadow-slot-nested":
        return html(`<div style="position:relative;height:260px"><slot-nest style="display:block;font:20px monospace;color:#ff0000"><span style="position:absolute;left:300px;top:200px">ret-1111</span></slot-nest></div><p>Plan: Team</p><script>customElements.define("slot-nest", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<div>card-sec<slot></slot></div>"; } });</script>`);
      case "/contents-relative":
      case "/contents-sticky":
        return html(`<div style="overflow:hidden;width:100px;height:30px;font:20px monospace;color:#ff0000"><span style="display:contents;position:${req.url === "/contents-relative" ? "relative" : "sticky"}"><p style="position:absolute;top:120px;left:20px;white-space:nowrap;margin:0">card-secret-1111</p></span></div><p>Plan: Team</p>`);
      case "/zero-width":
        return html(`<p style="font:20px monospace;color:#ff0000">Key: card-&#8203;secret-&#8203;1111</p><p>Plan: Team</p>`);
      case "/soft-hyphen":
        return html(`<p style="font:20px monospace;color:#ff0000">Key: card-sec&shy;ret-1111</p><p>Plan: Team</p>`);
      case "/direction-mark":
        return html(`<p style="font:20px monospace;color:#ff0000">Key: card-&#8206;secret-1111</p><p>Plan: Team</p>`);
      case "/bidi-isolate":
        return html(`<p style="font:20px monospace;color:#ff0000">Key: card-&#8294;secret&#8297;-1111</p><p>Plan: Team</p>`);
      case "/grapheme-joiner":
        return html(`<p style="font:20px monospace;color:#ff0000">Key: card-s&#847;ecret-1111</p><p>Plan: Team</p>`);
      case "/invisible-separator":
        return html(`<p style="font:20px monospace;color:#ff0000">Key: card-&#8291;secret-1111</p><p>Plan: Team</p>`);
      case "/script-shown":
        return html(`<script type="application/json" style="display:block;font:20px monospace;color:#ff0000">{"token":"card-secret-1111"}</script><p>Plan: Team</p>`);
      case "/style-shown":
        return html(`<style style="display:block;font:20px monospace;color:#ff0000">/* card-secret-1111 */</style><p>Plan: Team</p>`);
      case "/zero-width-field":
        return html(`<input aria-label="Key" style="width:400px;font:20px monospace;color:#ff0000" value="card-&#8203;secret-1111"><p>Plan: Team</p>`);
      case "/head-shown":
        return html(`<style>head, title { display: block; font: 20px monospace; color: #ff0000 }</style><p>Plan: Team</p><script>document.head.append(Object.assign(document.createElement("title"), { textContent: "card-secret-1111" }));</script>`);
      case "/shadow-moving-part":
        return html(`<key-view></key-view><p>Plan: Team</p><script>customElements.define("key-view", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<style>:host{display:block;font:20px monospace;color:#ff0000} @keyframes hop{to{transform:translateY(120px)}} .hop{display:inline-block;animation:hop 20s steps(2) infinite}</style><span>card-</span><span class="hop">secret-</span><span>1111</span>'; } });</script>`);
      case "/nested-moving-part":
        return html(`<p style="font:20px monospace;color:#ff0000">card-<key-tail></key-tail></p><p>Plan: Team</p><script>customElements.define("key-tail", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<style>@keyframes hop{to{transform:translateY(120px)}} span{display:inline-block;animation:hop 20s steps(2) infinite}</style><span>secret-1111</span>'; } });</script>`);
      case "/moving-component":
        return html(`<style>@keyframes hop{to{transform:translateY(120px)}} key-tail{display:inline-block;animation:hop 20s steps(2) infinite}</style><p style="font:20px monospace;color:#ff0000">card-<key-tail></key-tail></p><p>Plan: Team</p><script>customElements.define("key-tail", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).textContent = "secret-1111"; } });</script>`);
      case "/slotted-carried":
        return html(`<carry-host style="display:block;font:20px monospace;color:#ff0000">secret-1111</carry-host><p>Plan: Team</p><script>customElements.define("carry-host", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<style>@keyframes carry{to{transform:translateY(120px)}} .carry{display:inline-block;animation:carry 20s steps(2) infinite}</style>card-<span class="carry"><slot></slot></span>'; } });</script>`);
      case "/slotted-carried-element":
        return html(`<carry-host style="display:block;font:20px monospace;color:#ff0000"><p>card-secret-1111</p></carry-host><p>Plan: Team</p><script>customElements.define("carry-host", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<style>@keyframes carry{to{transform:translateY(120px)}} .carry{animation:carry 20s steps(2) infinite}</style><div class="carry"><slot></slot></div>'; } });</script>`);
      case "/sibling-pusher":
        return html(`<style>@keyframes push{from{height:0}to{height:160px}} .pusher{animation:push 20s steps(2) infinite}</style><div class="pusher"></div><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p>`);
      case "/pusher-elsewhere":
        return html(`<style>@keyframes push{from{height:0}to{height:160px}} .pusher{animation:push 20s steps(2) infinite}</style><header><p>Banner</p><div class="pusher"></div></header><main><section><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></section></main>`);
      case "/frame-pushed":
        return html(`<style>@keyframes push{from{height:0}to{height:160px}} .pusher{animation:push 20s steps(2) infinite}</style><div class="pusher"></div><iframe style="width:600px;height:80px;border:0" srcdoc="<p style='font:20px monospace;color:#ff0000'>card-secret-1111</p>"></iframe>`);
      case "/frame-carried":
        return html(`<style>@keyframes carry{to{transform:translateY(120px)}} .carrier{animation:carry 20s steps(2) infinite}</style><div class="carrier"><iframe style="width:600px;height:80px;border:0" srcdoc="<p style='font:20px monospace;color:#ff0000'>card-secret-1111</p>"></iframe></div>`);
      case "/shadow-card":
      case "/shadow-card-other":
        return html(`<key-card></key-card><script>customElements.define("key-card", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<div style="font:20px sans-serif;width:640px"><h2>${req.url === "/shadow-card" ? "Settings" : "Preferences"}</h2><p>Plan: Team</p><p>Key: <span style="color:#ff0000">card-secret-1111</span></p><p>Billing: monthly</p><p>Seats: 5</p></div>'; } });</script>`);
      case "/animated-underline":
        return html(`<style>@keyframes underline{from{width:0}to{width:100%}} .card{position:relative;width:420px;padding:8px} .card::after{content:"";position:absolute;left:0;bottom:0;height:2px;background:#333;animation:underline 1s linear infinite alternate}</style><div class="card"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div><p>Plan: Team</p>`);
      case "/svg-status-dot":
        return html(`<style>@keyframes pulse{from{r:3px}to{r:7px}} circle{animation:pulse 600ms ease-in-out infinite alternate}</style><p><svg width="16" height="16"><circle cx="8" cy="8" r="5" fill="#2a2"></circle></svg> Online</p><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p>`);
      case "/frame-nested-carried":
        return html(`<style>@keyframes carry{to{transform:translateY(120px)}} .carrier{animation:carry 20s steps(2) infinite}</style><div class="carrier"><iframe style="width:640px;height:120px;border:0" srcdoc="${`<iframe style='width:600px;height:80px;border:0' srcdoc='&lt;p style=&quot;font:20px monospace;color:#ff0000&quot;&gt;card-secret-1111&lt;/p&gt;'></iframe>`.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></div>`);
      case "/clip-reveal":
        return html(`<style>@keyframes reveal{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}} .banner{animation:reveal 1s linear infinite}</style><p class="banner">New plans available</p><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p>`);
      case "/backdrop-pulse":
        return html(`<style>@keyframes glass{from{backdrop-filter:blur(0)}to{backdrop-filter:blur(4px)}} .glass{padding:8px;animation:glass 800ms linear infinite alternate}</style><div class="glass">Status</div><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p>`);
      case "/zindex-step":
        return html(`<style>@keyframes lift{from{z-index:1}to{z-index:5}} .tile{position:relative;animation:lift 400ms steps(2) infinite}</style><div class="tile">Tile</div><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p>`);
      case "/title-secret":
        return html(`<style>@keyframes load{from{width:10%}to{width:90%}} .bar{height:4px;background:#333;animation:load 1s linear infinite}</style><div class="bar"></div><plan-note></plan-note><p>Hello</p><script>document.title = "Inbox - card-secret-1111"; customElements.define("plan-note", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "Plan: Team"; } });</script>`);
      case "/emphasis-pusher":
        return html(`<style>@keyframes marks{from{text-emphasis-style:none}to{text-emphasis-style:filled}} .note{font:20px/1 sans-serif;text-emphasis-position:under;animation:marks 20s steps(2) infinite}</style><p class="note">Heads up<br>Read this<br>Then this</p><p style="font:20px monospace;color:#ff0000">card-secret-1111</p>`);
      case "/slotted-part-moving":
        return html(`<style>@keyframes hop{to{transform:translateY(120px)}} .hop{display:inline-block;animation:hop 20s steps(2) infinite}</style><part-host style="display:block;font:20px monospace;color:#ff0000"><span class="hop">ret-1111</span></part-host><p>Plan: Team</p><script>customElements.define("part-host", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<div id="wrap">card-sec<slot></slot></div>'; } });</script>`);
      case "/emphasis-tint":
        return html(`<style>@keyframes tint{to{text-emphasis-color:#999}} .key{font:20px monospace;color:#ff0000;text-emphasis:filled #ccc;animation:tint 800ms linear infinite alternate}</style><p class="key">card-secret-1111</p><p>Plan: Team</p>`);
      case "/fixed-progress":
        return html(`<style>@keyframes load{from{width:0}to{width:100%}} .bar{position:fixed;top:0;left:0;height:4px;background:#333;animation:load 1s linear infinite}</style><div class="bar"></div><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p>`);
      case "/popover-growing":
        return html(`<style>@keyframes grow{from{height:0}to{height:80px}} .menu{position:absolute;top:120px;left:300px;width:160px;background:#eee} .menu div{animation:grow 1s linear infinite alternate}</style><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p><div class="menu"><div></div></div>`);
      case "/shaking-sibling":
        return html(`<style>@keyframes shake{from{left:0}to{left:8px}} .shake{position:relative;animation:shake 80ms linear infinite alternate}</style><p class="shake">Wrong password</p><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><p>Plan: Team</p>`);
      case "/closed-text":
        return html(closedCard("", "card-secret-1111"));
      case "/closed-groups":
        return html(closedCard("", "<span>card-</span><span>secret-</span><span>1111</span>"));
      case "/closed-split":
        return html(closedCard("card-sec", "<slot></slot><span>ret-1111</span>"));
      case "/closed-slotted":
        return html(`<div style="position:relative;height:260px"><closed-away style="display:block;overflow:hidden;height:24px;font:20px monospace;color:#ff0000">card-secret-1111</closed-away></div><p>Plan: Team</p><script>customElements.define("closed-away", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<div style="position:absolute;left:300px;top:200px"><slot></slot></div>'; } });</script>`);
      case "/closed-slot-after":
        return html(closedCard("ret-1111", "card-sec<slot></slot>"));
      case "/closed-slot-named":
        return html(closedCard('<span slot="tail">ret-1111</span>', 'card-sec<slot name="tail"></slot>'));
      case "/closed-slot-manual":
        return html(`<closed-manual style="display:block;font:20px monospace;color:#ff0000">ret-1111</closed-manual><p>Plan: Team</p><script>customElements.define("closed-manual", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "closed", slotAssignment: "manual" }); root.innerHTML = "card-sec<slot></slot>"; root.querySelector("slot").assign(this.firstChild); } });</script>`);
      case "/closed-sibling-hosts":
        return html(`<p style="font:20px monospace;color:#ff0000"><closed-a></closed-a><closed-b></closed-b></p><p>Plan: Team</p><script>customElements.define("closed-a", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "card-secret-"; } }); customElements.define("closed-b", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "1111"; } });</script>`);
      case "/closed-after-light":
        return html(`<p style="font:20px monospace;color:#ff0000">card-secret-<closed-b></closed-b></p><p>Plan: Team</p><script>customElements.define("closed-b", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "1111"; } });</script>`);
      case "/closed-password-tail":
        return html(`<p style="font:20px monospace;color:#ff0000">moving-s<closed-tail></closed-tail></p><p>Plan: Team</p><script>customElements.define("closed-tail", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "ecret-1"; } });</script>`);
      case "/phrase-newline":
        return html(`<p style="font:20px monospace;color:#ff0000">correct
          horse battery-42</p><p>Plan: Team</p>`);
      case "/phrase-nbsp":
        return html(`<p style="font:20px monospace;color:#ff0000">correct&nbsp;horse battery-42</p><p>Plan: Team</p>`);
      case "/phrase-double":
        return html(`<p style="font:20px monospace;color:#ff0000">correct  horse battery-42</p><p>Plan: Team</p>`);
      case "/closed-phrase":
        return html(closedCard("", "correct&nbsp;horse battery-42"));
      case "/closed-long-text":
        return html(closedCard("", `<p style="margin:0">${" ".repeat(10500)}card-secret-1111</p>`));
      case "/closed-zero-width":
        return html(closedCard("", "card-&#8203;secret-&#8203;1111"));
      case "/closed-password":
        return html(closedCard("", '<input aria-label="Password" type="password" value="closed-pass-1">'));
      case "/closed-typed":
        return html(`<closed-field></closed-field><p>Plan: Team</p><script>customElements.define("closed-field", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "closed" }); root.innerHTML = '<input aria-label="Key" style="width:400px;font:20px monospace;color:#ff0000">'; root.querySelector("input").value = "card-secret-1111"; } });</script>`);
      case "/closed-in-frame":
        return html(`<iframe style="width:600px;height:120px;border:0" srcdoc="${`<!doctype html>${closedCard("", "card-secret-1111")}`.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`);
      case "/cut-beside-closed":
        return html(`<p style="font:20px monospace;color:#ff0000;height:24px;overflow:hidden;margin:0">${" ".repeat(10500)}card-secret-<closed-b></closed-b></p><p>Plan: Team</p><script>customElements.define("closed-b", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "1111"; } });</script>`);
      case "/cut-empty-beside-closed":
        return html(`<p id="line" style="font:20px monospace;color:#ff0000;height:24px;overflow:hidden;margin:0">${" ".repeat(10500)}card-secret-<closed-b></closed-b></p><p>Plan: Team</p><script>customElements.define("closed-b", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "1111"; } }); const line = document.getElementById("line"); line.insertBefore(document.createTextNode("\\u200b"), line.lastElementChild);</script>`);
      case "/cut-near-closed":
        return html(`<p style="font:6px monospace;height:30px;overflow:hidden;margin:0">${"lorem ipsum ".repeat(900)}card-sec<b style="font:20px monospace;color:#ff0000">ret-</b><closed-b></closed-b></p><p>Plan: Team</p><script>customElements.define("closed-b", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<span style="font:20px monospace;color:#ff0000">1111</span>'; } });</script>`);
      case "/closed-flex-parts":
      case "/closed-grid-parts":
        return html(closedCard("", `<div style="display:${req.url === "/closed-flex-parts" ? "flex" : "inline-grid;grid-auto-flow:column"}"><span>card-sec</span>\n  <span>ret-1111</span></div>`));
      case "/closed-style-shown":
        return html(closedCard("", '<style style="display:block">/* card-secret-1111 */</style>'));
      case "/closed-phrase-words":
        return html(closedCard("", "<p><b>correct</b> <b>horse</b> <b>battery</b> <b>staple</b></p>"));
      case "/closed-invisible-needle":
        return html(closedCard("", "key&#8203;value-7777"));
      case "/field-invisible-needle":
        return html(`<input aria-label="Key" style="width:400px;font:20px monospace;color:#ff0000" value="key&#8203;value-7777"><p>Plan: Team</p>`);
      case "/head-contents":
        return html(`<style>head { display: contents } title { display: block; font: 20px monospace; color: #ff0000 }</style><p>Plan: Team</p><script>document.head.append(Object.assign(document.createElement("title"), { textContent: "card-secret-1111" }));</script>`);
      case "/cut-spaces-before-closed":
        return html(`<p style="font:6px monospace;height:30px;overflow:hidden;margin:0">${"lorem ipsum ".repeat(900)}correct horse</p>${" ".repeat(200)}<p style="font:20px monospace;color:#ff0000;margin:0"><closed-b></closed-b></p><p>Plan: Team</p><script>customElements.define("closed-b", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "battery staple"; } });</script>`);
      case "/cut-nbsp-before-closed":
        return html(`<p style="font:6px monospace;height:30px;overflow:hidden;margin:0">${"lorem ipsum ".repeat(900)}correct&nbsp;horse<closed-b></closed-b></p><p>Plan: Team</p><script>customElements.define("closed-b", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<span style="font:20px monospace;color:#ff0000"> battery staple</span>'; } });</script>`);
      case "/closed-beside-long-text":
        return html(`<closed-note>Help</closed-note><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><pre style="height:40px;overflow:hidden">${"log line ".repeat(1400)}</pre><script>customElements.define("closed-note", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<slot></slot>"; } });</script>`);
      case "/closed-after-long-text":
        return html(`<p style="font:20px monospace;color:#ff0000">card-secret-1111</p><pre style="height:40px;overflow:hidden">${"log line ".repeat(1400)}</pre><p style="height:20px;overflow:hidden">${"filler text ".repeat(600)}</p><closed-note>Help</closed-note><script>customElements.define("closed-note", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<slot></slot>"; } });</script>`);
      case "/closed-plain":
        return html(`<closed-note>Plan</closed-note><p style="font:20px monospace;color:#ff0000">card-secret-1111</p><script>customElements.define("closed-note", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<slot></slot>: Team"; } });</script>`);
      case "/pusher":
        return html(`<style>@keyframes push{from{height:0}to{height:160px}} .pusher{display:inline-block;width:4px;animation:push 20s steps(2) infinite}</style><p style="font:20px monospace;color:#ff0000"><span class="pusher"></span>card-secret-1111</p>`);
      case "/big-icon":
      case "/big-icon-other":
        return html(`<style>@keyframes spin{to{transform:rotate(360deg)}} .icon{display:inline-block;width:30px;height:30px;background:#333;animation:spin 1s linear infinite}</style><h1>${req.url === "/big-icon" ? "Settings" : "Preferences"}</h1><p style="font:20px/24px monospace;color:#ff0000">Key: card-secret-1111 <span class="icon"></span></p><p>Plan: Team</p><p>Billing: monthly</p><p>Seats: 5</p>`);
      case "/custom-timeline":
        return html(`<p id="echo" style="font:20px monospace;color:#ff0000">card-secret-1111</p><script>document.getElementById("echo").animate([{ transform: "translateX(0)" }, { transform: "translateX(200px)" }], { duration: 20000, easing: "steps(2)", iterations: Infinity, timeline: new DocumentTimeline() });</script>`);
      case "/decorated-card":
        return html(`<style>@keyframes turn{to{transform:rotate(360deg)}} .card{position:relative;overflow:hidden;padding:16px;width:420px} .card::before{content:"";position:absolute;inset:-50%;background:conic-gradient(#eee,#ccc,#eee);animation:turn 3s linear infinite;z-index:-1}</style><div class="card"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div>`);
      case "/pushing-before":
        return html(`<style>@keyframes grow{from{height:0}to{height:160px}} .card::before{content:"";display:block;animation:grow 20s steps(2) infinite}</style><div class="card"><p style="font:20px monospace;color:#ff0000">card-secret-1111</p></div>`);
      case "/fixed-below":
        return html(`<p>Short page</p><div style="position:fixed;left:20px;bottom:120px;height:0;font:20px monospace;color:#ff0000">card-secret-1111</div>`);
      case "/flicker":
        return html(`<style>@keyframes jump{0%,49.9%{transform:translateY(0)}50%,100%{transform:translateY(120px)}} #echo{font:20px monospace;color:#ff0000;animation:jump 60ms infinite}</style><p id="echo">card-secret-1111</p>`);
      case "/static-secret":
        return html(`<p style="font:20px monospace;color:#ff0000">Your key is card-secret-1111</p><p>Plan: Team</p>`);
      case "/scroll-code":
      case "/scroll-code-other":
        return html(`<div style="font:16px sans-serif;width:640px"><h2>${req.url === "/scroll-code" ? "Use the API" : "Call the API"}</h2><pre style="overflow:auto;width:300px;font:14px monospace;color:#ff0000">curl -H "Authorization: Bearer card-secret-1111" https://api.example.com/v1/projects?limit=100</pre><p>Paragraph below</p><p>Another paragraph</p><p>And another</p></div>`);
      case "/ellipsis":
      case "/ellipsis-other":
        return html(`<div style="font:16px sans-serif"><h2>${req.url === "/ellipsis" ? "API keys" : "Access keys"}</h2><table><tr><td>Production</td><td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ff0000">card-secret-1111-and-a-long-tail</td></tr><tr><td>Plan</td><td>Team</td></tr><tr><td>Region</td><td>EU</td></tr><tr><td>Seats</td><td>5</td></tr></table><p>Paragraph below</p></div>`);
      case "/overflow-edge":
        return html(`<div id="parent" style="font:20px monospace"><p id="secret" style="width:100px;white-space:nowrap;color:#ff0000;margin:0">card-secret-11112</p></div><p>After</p><p>More</p><p>And more</p><p>Still more</p><script>const text = document.createRange(); text.selectNodeContents(document.getElementById("secret")); document.getElementById("parent").style.width = (text.getBoundingClientRect().width - 5) + "px";</script>`);
      case "/zero-height":
        return html(`<div style="font:20px sans-serif;padding:16px;border:1px solid #999;width:640px"><h2>Account settings</h2><div style="height:0;color:#ff0000">card-secret-1111</div><p>Plan: Team</p><p>Billing: monthly</p></div>`);
      case "/clock":
        return html(`<style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}} #spinner{width:20px;height:20px;background:#333;animation:spin 1s linear infinite}</style><div id="spinner"></div><button onclick="document.getElementById('drift').textContent = 'behind by ' + Math.round(performance.now() - document.timeline.currentTime) + ' ms'">Clock</button><p id="drift">not read</p>`);
      case "/boxes-faked":
        return html(`<p style="font:20px monospace;color:#ff0000">Your key is card-secret-1111</p><script>Element.prototype.getBoundingClientRect = () => { throw new Error("no boxes here"); }; Element.prototype.getClientRects = () => [];</script>`);
      case "/hooked":
        return html(`<script>window.seen = []; const decode = TextDecoder.prototype.decode; TextDecoder.prototype.decode = function (...a) { const out = decode.apply(this, a); window.seen.push(String(out)); return out; }; const decodeBase64 = window.atob; window.atob = (s) => { const out = decodeBase64(s); window.seen.push(out); return out; }; window.RegExp = new Proxy(RegExp, { construct: (target, args) => (window.seen.push(String(args[0])), new target(...args)), apply: (target, self, args) => (window.seen.push(String(args[0])), target(...args)) });</script><input aria-label="Password" type="password"><button onclick="const o=document.querySelector('input');const n=document.createElement('input');n.setAttribute('aria-label','Password');n.value=o.value;o.replaceWith(n)">Show password</button><p>Your key is hook-header-secret-1</p><button onclick="document.getElementById('seen').textContent = 'seen ' + window.seen.filter((s) => s.includes('hook-') || s.includes('aG9vay')).length">Report</button><p id="seen">not reported</p>`);
      case "/shadow-reveal":
        return html(`<trawler-card></trawler-card><script>customElements.define("trawler-card", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "open" }); root.innerHTML = '<input aria-label="Password" type="password"><button>Reveal</button>'; root.querySelector("button").onclick = () => { const o = root.querySelector("input"); const n = document.createElement("input"); n.setAttribute("aria-label", "Password"); n.style.cssText = "width:600px;font:20px monospace;color:#ff0000"; n.value = o.value; o.replaceWith(n); }; } });</script>`);
      case "/frames-keep-coming":
        return html(`<p>Frames</p><script>let n = 0; const add = () => { const f = document.createElement("iframe"); f.style.cssText = "width:300px;height:40px;border:0"; f.srcdoc = '<p style="margin:0;font:20px monospace;color:#ff0000">card-secret-1111</p>'; document.body.append(f); if (++n < 60) setTimeout(add, 25); else document.body.insertAdjacentHTML("beforeend", "<p>All frames added</p>"); }; add();</script>`);
      case "/held-animation":
        return html(`<style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}} #spinner{width:20px;height:20px;background:#333;animation:spin 1s linear infinite} #spinner.hold{animation-play-state:paused}</style><div id="spinner"></div><button onclick="const a = document.getAnimations()[0]; const before = a.currentTime; setTimeout(() => document.getElementById('state').textContent = a.currentTime > before ? 'spinning' : 'still', 150)">Check</button><button onclick="document.getElementById('spinner').classList.add('hold'); setTimeout(() => document.getElementById('state').textContent = 'held: ' + document.getAnimations()[0].playState, 50)">Hold</button><p id="state">unknown</p>`);
      case "/visible-password-a":
        return html(`<input aria-label="Password" type="password" value="short-pw-1">`);
      case "/visible-password-b":
        return html(`<input aria-label="Password" type="password" value="a-much-longer-password-2">`);
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
      case "/dialog-chain":
        return html(`<button onclick="if (!confirm('Sure?')) alert('Cancelled')">Delete</button>`);
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
  const browser = await openBrowser({ allowedOrigins: [origin], outputDir: dir, scrubber, onBlocked: (u) => blocked.push(u), actionGapMs: 0, ...extra });
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

  test("names the page the person is on, and none before a page is open", async () => {
    await withBrowser(async (b) => {
      expect(b.pageUrl()).toBeNull();
      await navigate(b, `${origin}/plain?step=2`);
      expect(b.pageUrl()).toBe(`${origin}/plain?step=2`);
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

  test("the product sees a person's actions at least the gap apart, even two sent at once, while a snapshot waits for nothing", async () => {
    await withBrowser(async (b) => {
      pacedHits.length = 0;
      await navigate(b, `${origin}/paced`);
      const looked = Date.now();
      await snapshot(b);
      expect(Date.now() - looked).toBeLessThan(600);
      await Promise.all([navigate(b, `${origin}/paced`), navigate(b, `${origin}/paced`)]);
      expect(pacedHits).toHaveLength(3);
      expect(pacedHits[1]! - pacedHits[0]!).toBeGreaterThanOrEqual(700);
      expect(pacedHits[2]! - pacedHits[1]!).toBeGreaterThanOrEqual(700);
    }, { actionGapMs: 700 });
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

describe("native dialogs", () => {
  const LEAVE = `["beforeunload" dialog: the browser asks "Leave site? Changes you made may not be saved."]: can be handled by browser_handle_dialog`;
  const call = async (b: Browser, name: string, args: Record<string, unknown> = {}) => {
    const started = Date.now();
    const out = (await b.tools[name]!.execute!(args, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: out.content.map((c) => c.text).join("\n"), isError: out.isError === true, ms: Date.now() - started };
  };
  const linkRef = async (b: Browser, label: string) => new RegExp(`(?:link|button) \\\\"${label}\\\\"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(await snapshot(b))![1]!;

  test("a Leave site? prompt on going to another address shows at once, as when a link is clicked, instead of the tool hanging for a minute", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/unsaved-edit`);
      const byAddress = await call(b, "browser_navigate", { url: `${origin}/plain` });
      expect(byAddress.text).toContain(LEAVE);
      expect(byAddress.ms).toBeLessThan(5000);
      expect(await call(b, "browser_handle_dialog", { accept: false })).toMatchObject({ isError: false });
      expect(await snapshot(b)).toContain("Edit venture");

      const byLink = await call(b, "browser_click", { element: "Back to list", target: await linkRef(b, "Back to list") });
      expect(byLink.text).toContain(LEAVE);
      expect(await call(b, "browser_handle_dialog", { accept: true })).toMatchObject({ isError: false });
      expect(await snapshot(b)).toContain(`${origin}/plain`);
    });
  }, 60_000);

  test("while a dialog waits for an answer, every other tool says so at once and names it", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/unsaved-edit`);
      await call(b, "browser_navigate", { url: `${origin}/plain` });
      for (const [name, args] of [["browser_snapshot", {}], ["browser_navigate", { url: `${origin}/plain` }], ["browser_navigate_back", {}]] as const) {
        const answer = await call(b, name, args);
        expect(answer).toMatchObject({ isError: true });
        expect(answer.text).toContain(LEAVE);
        expect(answer.ms).toBeLessThan(5000);
      }
      await call(b, "browser_handle_dialog", { accept: false });
      expect(await call(b, "browser_snapshot")).toMatchObject({ isError: false });
    });
  }, 60_000);

  test("an alert in a popup the tools cannot reach locks nothing: the tab the tools act on carries on", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/opens-alerting-popup`);
      await call(b, "browser_click", { element: "Open popup", target: await linkRef(b, "Open popup") });
      await new Promise((r) => setTimeout(r, 1000));
      expect(await call(b, "browser_snapshot")).toMatchObject({ isError: false });
      const moved = await call(b, "browser_navigate", { url: `${origin}/plain` });
      expect(moved).toMatchObject({ isError: false });
      expect(moved.ms).toBeLessThan(5000);
    });
  }, 60_000);

  test("an alert shows its own message", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/unsaved-edit`);
      const clicked = await call(b, "browser_click", { element: "Save", target: await linkRef(b, "Save") });
      expect(clicked.text).toContain(`["alert" dialog with message "Saved!"]: can be handled by browser_handle_dialog`);
      expect(await call(b, "browser_handle_dialog", { accept: true })).toMatchObject({ isError: false });
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

  test("a password short enough for a short field is typed into it, and stays unmasked like any text that short", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/pin`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "PIN"), "482193", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Echo"), element: "Echo" }, ctx);
      const shown = await snapshot(b);
      expect(shown).toContain("Your PIN is 482193");
      expect(shown).toMatch(/textbox \\"PIN\\"[^\\]*: •••/);
      expect(await b.fillField(refOf(snap, "PIN"), "4821937", "password")).toBe("failed: the field takes at most 6 characters, fewer than the password has, so nothing was typed");
    });
  }, 60_000);

  test("the model never reads a password too short to scrub from the field it was typed into", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "pw12", "password")).toBe("typed the password");
      const shown = await snapshot(b);
      expect(shown).toMatch(/textbox \\"Password\\"[^\\]*: •••/);
      expect(shown).not.toContain("pw12");
    });
  }, 60_000);

  test.each([
    ["a placeholder that differs from its name", "/password-placeholder", "Password", "pw12", "pw12"],
    ["a name with a colon", "/password-colon-label", "Password: at least 4 characters", "pw12", "pw12"],
    ["spaces the page view collapses", "/", "Password", " pw  1", "pw 1"],
  ])("a password too short to scrub stays hidden in a field with %s", async (_, path, name, password, shown) => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}${path}`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, name), password, "password")).toBe("typed the password");
      const after = await snapshot(b);
      expect(after).toContain("•••");
      expect(after).not.toContain(shown);
    });
  }, 60_000);

  test.each([
    ["/password-placeholder", "Password"],
    ["/", "Password"],
  ])("a long password with leading and doubled spaces stays hidden in its own field on %s", async (path, name) => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}${path}`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, name), " ad  min-secret", "password")).toBe("typed the password");
      const after = await snapshot(b);
      expect(after).toMatch(/textbox \\"Password\\"[^\\]*(: •••|\\n\s*- \/placeholder: [^\\]*\\n\s*- text: •••)/);
      expect(after).not.toContain("ad min-secret");
    });
  }, 60_000);

  test("page text that shows a long password with its spaces collapsed is masked like the password itself", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/signed-in-as-long`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), " ad  min-secret", "password")).toBe("typed the password");
      const shown = await snapshot(b);
      expect(shown).toMatch(/paragraph[^\\]*: •••/);
      expect(shown).not.toContain("ad min-secret");
    });
  }, 60_000);

  test.each([
    ["an invisible character", "/", "Password", "ad\u200bmin-secret", "admin-secret"],
    ["a soft hyphen", "/", "Password", "ad\u00admin-secret", "admin-secret"],
    ["the page changing it", "/password-shouted", "Password", " ad  min-secret", "AD MIN-SECRET"],
    ["the project's own secret inside it", "/", "Password", "hunter22-secret  2024", "2024"],
    ["an invisible character, too short to scrub", "/", "Password", "pw\u200b12", "pw12"],
    ["the page changing it, too short to scrub", "/password-shouted", "Password", "pw12ab", "PW12AB"],
  ])("a password with %s is hidden in its own field", async (_, path, name, password, shown) => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}${path}`);
      expect(await b.fillField(refOf(await snapshot(b), name), password, "password")).toBe("typed the password");
      const after = await snapshot(b);
      expect(after).toMatch(/textbox \\"Password\\"[^\\]*: •••/);
      expect(after).not.toContain(shown);
    });
  }, 60_000);

  test.each([" ad  min-secret", "pw  12"])("a password field the page turns into a search box keeps %j hidden", async (password) => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/password-shown-as-search`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), password, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "Show password" }, ctx);
      const after = await snapshot(b);
      expect(after).toMatch(/searchbox \\"Password\\"[^\\]*: •••/);
      expect(after).not.toContain(password.replace(/\s+/g, " ").trim());
    });
  }, 60_000);

  test("a typed password shown in another field on a later page is hidden there too", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), " ad  min-secret", "password")).toBe("typed the password");
      await navigate(b, `${origin}/password-copied`);
      const after = await snapshot(b);
      expect(after).toMatch(/textbox \\"Your password\\"[^\\]*: •••/);
      expect(after).not.toContain("ad min-secret");
    });
  }, 60_000);

  test("page text that happens to equal a password too short to scrub stays readable, only the field is hidden", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/signed-in-as`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "admin", "password")).toBe("typed the password");
      const shown = await snapshot(b);
      expect(shown).toMatch(/paragraph[^\\]*: admin/);
      expect(shown).toMatch(/textbox \\"Password\\"[^\\]*: •••/);
    });
  }, 60_000);

  test("a failed fill of a password too short to scrub does not repeat it", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/readonly-password`);
      const snap = await snapshot(b);
      const out = await b.fillField(refOf(snap, "Password"), "pw12", "password");
      expect(out).toMatch(/^failed: /);
      expect(out).not.toContain("pw12");
    });
  }, 60_000);

  test("a field whose text contains a password too short to mask can still be typed into", async () => {
    await withBrowser(async (b) => {
      await navigate(b, origin);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "pw12", "password")).toBe("typed the password");
      const first = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Email"), text: "pw12@acme.test", element: "email" }, ctx)) as { isError?: boolean };
      expect(first.isError).toBeFalsy();
      const again = (await b.tools.browser_type!.execute!({ target: refOf(snap, "Email"), text: "kwame@acme.test", element: "email" }, ctx)) as { isError?: boolean };
      expect(again.isError).toBeFalsy();
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

  test("a password field that goes away right after typing is reported as not known to be kept", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/closing-frame`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("failed: the page moved on before the field could be checked, so it is not known what the field kept");
    });
  }, 60_000);

  test("a word the page puts into a password field after typing is hidden only while the field holds it", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/reset-to-placeholder`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Reset"), element: "Reset" }, ctx);
      await navigate(b, `${origin}/placeholder`);
      expect(await snapshot(b)).toContain("Forgot password? Change your password below.");
    });
  }, 60_000);

  test("a word the page puts into a field after a password too short to scrub never becomes a secret", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/reset-to-placeholder`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "pwd", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Reset"), element: "Reset" }, ctx);
      await navigate(b, `${origin}/placeholder`);
      const shown = await snapshot(b);
      expect(shown).toContain("Forgot password? Change your password below.");
      const search = (await b.tools.browser_type!.execute!({ target: refOf(shown, "Search"), text: "password reset", element: "search" }, ctx)) as { isError?: boolean };
      expect(search.isError).toBeFalsy();
    });
  }, 60_000);

  test("a password the page spreads out inside its field stays hidden after the form is sent", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/space-out`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "Kx7mPq2Rz9Lw!Aa7", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Space out"), element: "Space out" }, ctx);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Save"), element: "Save" }, ctx);
      const shown = await snapshot(b);
      expect(shown).toContain("Your password is •••");
      expect(shown).not.toContain("K x 7 m");
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
    const b = await openBrowser({ allowedOrigins: [origin], outputDir: dir, scrubber, onBlocked: () => {}, actionGapMs: 0 });
    try {
      await navigate(b, origin);
      await b.close();
      await expect(b.tools.browser_snapshot!.execute!({}, ctx)).rejects.toThrow(/browser has closed|closed client/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("closing with a dialog still open is quick, and leaves no Chromium running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trw-"));
    const b = await openBrowser({ allowedOrigins: [origin], outputDir: dir, scrubber: new SecretScrubber(), onBlocked: () => {}, actionGapMs: 0 });
    try {
      await navigate(b, `${origin}/dialog`);
      const clicked = JSON.stringify(await b.tools.browser_click!.execute!({ target: refOf(await snapshot(b), "Delete"), element: "Delete" }, ctx));
      expect(clicked).toContain("Modal state");
      const started = performance.now();
      await b.close();
      expect(performance.now() - started).toBeLessThan(1500);
      expect(() => execFileSync("pgrep", ["-P", String(process.pid), "-f", "chrom"])).toThrow(expect.objectContaining({ status: 1 }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("closing still ends Chromium when dismissing one dialog opens another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trw-"));
    const b = await openBrowser({ allowedOrigins: [origin], outputDir: dir, scrubber: new SecretScrubber(), onBlocked: () => {}, actionGapMs: 0 });
    try {
      await navigate(b, `${origin}/dialog-chain`);
      await b.tools.browser_click!.execute!({ target: refOf(await snapshot(b), "Delete"), element: "Delete" }, ctx);
      const started = performance.now();
      await b.close();
      expect(performance.now() - started).toBeLessThan(8000);
      expect(() => execFileSync("pgrep", ["-P", String(process.pid), "-f", "chrom"])).toThrow(expect.objectContaining({ status: 1 }));
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

describe("screenshots", () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let decoder: PlaywrightBrowser;
  beforeAll(async () => {
    decoder = await chromium.launch();
  }, 60_000);
  afterAll(() => decoder.close(), 60_000);

  async function redPixels(shot: Screenshot): Promise<number> {
    const page = await decoder.newPage();
    try {
      return await page.evaluate(async (png) => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, image.width, image.height).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i]! > 200 && data[i + 1]! < 80 && data[i + 2]! < 80) red++;
        return red;
      }, Buffer.from(shot.bytes).toString("base64"));
    } finally {
      await page.close();
    }
  }

  async function differingRegion(first: Screenshot, second: Screenshot): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)) === 0) return null;
    const page = await decoder.newPage();
    try {
      return await page.evaluate(
        async ([a, b]) => {
          const pixels = async (png: string) => {
            const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
            const canvas = new OffscreenCanvas(image.width, image.height);
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            return { width: image.width, data: context.getImageData(0, 0, image.width, image.height).data };
          };
          const [one, two] = [await pixels(a!), await pixels(b!)];
          let [left, top, right, bottom] = [Infinity, Infinity, -1, -1];
          for (let i = 0; i < Math.min(one.data.length, two.data.length); i += 4) {
            if (one.data[i] === two.data[i] && one.data[i + 1] === two.data[i + 1] && one.data[i + 2] === two.data[i + 2]) continue;
            const x = (i / 4) % one.width, y = Math.floor(i / 4 / one.width);
            [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
          }
          return right < 0 ? { x: 0, y: 0, width: 0, height: 0 } : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
        },
        [Buffer.from(first.bytes).toString("base64"), Buffer.from(second.bytes).toString("base64")],
      );
    } finally {
      await page.close();
    }
  }

  async function shotsOf(path: string, count: number, setUp: (b: Browser, snap: string) => Promise<unknown>, extra: Partial<Parameters<typeof openBrowser>[0]> = {}): Promise<Array<Screenshot | null>> {
    const shots: Array<Screenshot | null> = [];
    await withBrowser(async (b) => {
      await navigate(b, `${origin}${path}`);
      await setUp(b, await snapshot(b));
      for (let i = 0; i < count; i++) shots.push(await b.screenshot());
    }, extra);
    return shots;
  }

  const typeAndClick = (button: string) => async (b: Browser, snap: string) => {
    expect(await b.fillField(refOf(snap, "Password"), "moving-secret-1", "password")).toBe("typed the password");
    await b.tools.browser_click!.execute!({ target: refOf(snap, button), element: button }, ctx);
    await new Promise((r) => setTimeout(r, 100));
  };

  const knowing = (secret: string) => {
    const scrubber = new SecretScrubber();
    scrubber.add(secret);
    return { scrubber };
  };

  async function screenshotAfter(password: string, path: string, then: (b: Browser, snap: string) => Promise<unknown>): Promise<Screenshot> {
    const taken: { shot: Screenshot | null } = { shot: null };
    await withBrowser(async (b) => {
      await navigate(b, `${origin}${path}`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), password, "password")).toBe("typed the password");
      await then(b, snap);
      taken.shot = await b.screenshot();
    });
    if (!taken.shot) throw new Error("no screenshot was taken");
    return taken.shot;
  }

  test("a password shown in plain text, in a field that replaced the password field, is masked", async () => {
    const show = (b: Browser, snap: string) => b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show" }, ctx);
    const first = await screenshotAfter("first-secret-1", "/remount", show);
    const second = await screenshotAfter("other-secret-2", "/remount", show);
    expect(first.contentType).toBe("image/png");
    expect(Buffer.from(first.bytes).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
  }, 120_000);

  test("a password the page repeats as text is masked", async () => {
    const save = (b: Browser, snap: string) => b.tools.browser_click!.execute!({ target: refOf(snap, "Save"), element: "save" }, ctx);
    const first = await screenshotAfter("first-secret-1", "/space-out", save);
    const second = await screenshotAfter("other-secret-2", "/space-out", save);
    expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
  }, 120_000);

  test("a password field is masked even when Trawler typed nothing into it, so not even its length shows", async () => {
    const shotOf = async (path: string) => {
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}${path}`);
        taken.shot = await b.screenshot();
      });
      return Buffer.from(taken.shot?.bytes ?? []);
    };
    const first = await shotOf("/visible-password-a");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotOf("/visible-password-b"))).toBe(0);
  }, 120_000);

  test("taking a screenshot leaves the page as it was: a message that removes itself when its animation ends is still there, and in the picture", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/toast`);
      expect(await snapshot(b)).toContain("Could not save: error 500");
      expect(await b.screenshot()).not.toBeNull();
      expect(await snapshot(b)).toContain("Could not save: error 500");
    });
  }, 60_000);

  test("a secret the run knows but never typed, like a secret header's value, is masked where the page shows it", async () => {
    const shotOf = async (path: string, secret: string) => {
      const scrubber = new SecretScrubber();
      scrubber.add(secret);
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}${path}`);
        taken.shot = await b.screenshot();
      }, { scrubber });
      return Buffer.from(taken.shot?.bytes ?? []);
    };
    const first = await shotOf("/api-key-a", "sk-live-first-1");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotOf("/api-key-b", "sk-live-other-2"))).toBe(0);
  }, 120_000);

  test("a page that shows only the token of an Authorization secret header has the token masked", async () => {
    const shotOf = async (path: string, token: string) => {
      const scrubber = SecretScrubber.forProject({ accounts: [], secretHeaders: { authorization: `Bearer ${token}` } });
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}${path}`);
        taken.shot = await b.screenshot();
      }, { scrubber });
      return Buffer.from(taken.shot?.bytes ?? []);
    };
    const first = await shotOf("/api-key-a", "sk-live-first-1");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotOf("/api-key-b", "sk-live-other-2"))).toBe(0);
  }, 120_000);

  test("a field masked for a screenshot because it showed a password can be typed into again once it no longer does", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/reveal-clear`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), PASSWORD, "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show" }, ctx);
      expect(await b.screenshot()).not.toBeNull();
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Clear"), element: "clear" }, ctx);
      const cleared = await snapshot(b);
      const typed = (await b.tools.browser_type!.execute!({ target: refOf(cleared, "Password"), text: "hello", element: "field" }, ctx)) as { isError?: boolean };
      expect(typed.isError).toBeFalsy();
    });
  }, 60_000);

  test("the masks never cover what is not secret: pages that differ in ordinary text give different screenshots", async () => {
    const shotOf = async (path: string) => {
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}${path}`);
        taken.shot = await b.screenshot();
      });
      return Buffer.from(taken.shot?.bytes ?? []);
    };
    const first = await shotOf("/text-a");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotOf("/text-b"))).not.toBe(0);
  }, 120_000);

  test("a password shown inside a frame of the page is masked too", async () => {
    const shotAfter = async (password: string) => {
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}/frame-remount`);
        const snap = await snapshot(b);
        expect(await b.fillField(refOf(snap, "Password"), password, "password")).toBe("typed the password");
        await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show" }, ctx);
        taken.shot = await b.screenshot();
      });
      return Buffer.from(taken.shot?.bytes ?? []);
    };
    const first = await shotAfter("first-secret-1");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotAfter("other-secret-2"))).toBe(0);
  }, 120_000);

  test("a password field in a frame from another allowed origin is masked, so not even the length of what was typed shows", async () => {
    const shotAfter = async (password: string) => {
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}/cross-frame`);
        const snap = await snapshot(b);
        expect(await b.fillField(refOf(snap, "Inner password"), password, "password")).toBe("typed the password");
        taken.shot = await b.screenshot();
      }, { allowedOrigins: [origin, secondOrigin] });
      return Buffer.from(taken.shot?.bytes ?? []);
    };
    const first = await shotAfter("short-secret-1");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotAfter("a-much-longer-secret-2"))).toBe(0);
  }, 120_000);

  test("a password the page changed after it was typed is masked where the page repeats it", async () => {
    const swap = (b: Browser, snap: string) => b.tools.browser_click!.execute!({ target: refOf(snap, "Swap"), element: "swap" }, ctx);
    const first = await screenshotAfter("first-secret-1", "/swap-echo", swap);
    const second = await screenshotAfter("fresh-secret-2", "/swap-echo", swap);
    expect(await differingRegion(first, second)).toBeNull();
  }, 120_000);

  test("a password the page changed on its own after it was typed is masked even when reading the field is slow", async () => {
    const shotAfter = async (password: string) => {
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}/swap-later-slow`);
        expect(await b.fillField(refOf(await snapshot(b), "Password"), password, "password")).toBe("typed the password");
        await new Promise((r) => setTimeout(r, 1500));
        taken.shot = await b.screenshot();
        expect(await snapshot(b)).toContain("Swapped");
      });
      if (!taken.shot) throw new Error("no screenshot was taken");
      return taken.shot;
    };
    expect(await differingRegion(await shotAfter("first-secret-1"), await shotAfter("fresh-secret-2"))).toBeNull();
  }, 120_000);

  test("a password the page changed on its own never reaches the page text when reading the field is slow", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/swap-later-slow`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), "first-secret-1", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 1500));
      const text = await snapshot(b);
      expect(text).toContain("Swapped");
      expect(text).not.toContain("first-secret-");
    });
  }, 120_000);

  test("when a typed-into field cannot be read in time, the result is withheld rather than shown with a stale mask", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/swap-later-slow`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), "first-secret-1", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 1500));
      const text = await snapshot(b);
      expect(text).toContain("could not be read, so its result is withheld");
      expect(text).not.toContain("first-secret-");
    }, { filledReadMs: 0 });
  }, 120_000);

  test("a field whose own value getter throws is still read, so the password the page changed is masked, not withheld", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/swap-later-own-getter`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), "first-secret-1", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 1500));
      const text = await snapshot(b);
      expect(text).toContain("Swapped");
      expect(text).not.toContain("withheld");
      expect(text).not.toContain("first-secret-");
    });
  }, 120_000);

  test.each(["/swap-later-throws", "/swap-later-lies"])("a page that replaces the value getter (%s) cannot hide the password it changed", async (path) => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}${path}`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), "first-secret-1", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 1500));
      const text = await snapshot(b);
      expect(text).toContain("Swapped");
      expect(text).not.toContain("withheld");
      expect(text).not.toContain("first-secret-");
    });
  }, 120_000);

  test("a dialog opened by answering another stays known, so its result still says to answer it", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/swap-then-two-alerts`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "first-secret-1", "password")).toBe("typed the password");
      const results = [JSON.stringify(await b.tools.browser_click!.execute!({ target: refOf(snap, "Check"), element: "Check" }, ctx))];
      results.push(JSON.stringify(await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx)));
      results.push(JSON.stringify(await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx)));
      expect(results.slice(0, 2).every((r) => r.includes("a dialog is open"))).toBe(true);
      expect(results[2]).not.toContain("a dialog is open");
      expect(results.join("")).not.toContain("first-secret-");
    });
  }, 120_000);

  test("an alert in a popup the tools cannot reach does not withhold the results of the tab with the typed password, and the password stays masked", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/password-and-alerting-popup`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "first-secret-1", "password")).toBe("typed the password");
      const link = /link \\"Open popup\\"[^\n]*?\[ref=([a-z0-9]+)\]/.exec(snap)![1]!;
      await b.tools.browser_click!.execute!({ target: link, element: "Open popup" }, ctx);
      await new Promise((r) => setTimeout(r, 1500));
      const after = await snapshot(b);
      expect(after).not.toContain("withheld");
      expect(after).not.toContain("first-secret-");
      expect(after).toContain("Open popup");
    });
  }, 120_000);

  test("keys still reach the tab the tools act on while a popup shows an alert", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/search-and-alerting-popup`);
      let snap = await snapshot(b);
      await b.tools.browser_click!.execute!({ target: /link \\"Open popup\\"[^\n]*?\[ref=([a-z0-9]+)\]/.exec(snap)![1]!, element: "Open popup" }, ctx);
      await new Promise((r) => setTimeout(r, 1500));
      snap = await snapshot(b);
      await b.tools.browser_click!.execute!({ target: /searchbox \\"Search\\"[^\n]*?\[ref=([a-z0-9]+)\]/.exec(snap)![1]!, element: "Search" }, ctx);
      const pressed = JSON.stringify(await b.tools.browser_press_key!.execute!({ key: "ArrowDown" }, ctx));
      expect(pressed).not.toContain("Keys cannot be pressed");
    });
  }, 120_000);

  test("a popup opened by window.open that shows an alert neither hangs the tab that opened it nor needs an answer", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/opens-alerting-window`);
      const snap = await snapshot(b);
      const started = Date.now();
      const clicked = JSON.stringify(await b.tools.browser_click!.execute!({ target: refOf(snap, "Sign in with a popup"), element: "Sign in with a popup" }, ctx));
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(clicked).not.toContain("Modal state");
      expect(await snapshot(b)).toContain("Main");
    });
  }, 120_000);

  test("a dialog opened on a page with a typed password withholds the result, which says to answer the dialog", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/swap-then-alert`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "first-secret-1", "password")).toBe("typed the password");
      const clicked = JSON.stringify(await b.tools.browser_click!.execute!({ target: refOf(snap, "Check"), element: "Check" }, ctx));
      expect(clicked).toContain("a dialog is open");
      expect(clicked).not.toContain("first-secret-");
      const answered = JSON.stringify(await b.tools.browser_handle_dialog!.execute!({ accept: true }, ctx));
      expect(answered).not.toContain("a dialog is open");
      expect(answered).not.toContain("first-secret-");
    });
  }, 120_000);

  test("a password field the page fills with a value too long to check withholds the result and gives no screenshot", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/password-grows`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), "first-secret-1", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 1500));
      const started = performance.now();
      const text = await snapshot(b);
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(text).toContain("holds a value too long to check");
      expect(text).not.toContain("first-secret-");
      expect(await b.screenshot()).toBeNull();
    });
  }, 120_000);

  test("a page that keeps changing a typed password field stops getting results after 20 new values", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/password-keeps-changing`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "first-secret-1", "password")).toBe("typed the password");
      expect(await snapshot(b)).not.toContain("too long to check");
      const results: string[] = [];
      for (let i = 0; i < 21; i++) results.push(JSON.stringify(await b.tools.browser_click!.execute!({ target: refOf(snap, "Change"), element: "Change" }, ctx)));
      expect(results.slice(0, 20).some((r) => r.includes("too long to check"))).toBe(false);
      expect(results[20]).toContain("too long to check, or keeps changing it");
      expect(results.join("")).not.toContain("first-secret-");
    });
  }, 120_000);

  test("a page cannot pile up long secret forms: a second long, escape-heavy value withholds the result, and masking stays quick", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/password-fancy`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "first-secret-1", "password")).toBe("typed the password");
      const first = JSON.stringify(await b.tools.browser_click!.execute!({ target: refOf(snap, "Change"), element: "Change" }, ctx));
      const unchanged = await snapshot(b);
      expect(unchanged).not.toContain("too long to check");
      expect(unchanged).not.toContain("first-secret-");
      const started = performance.now();
      const second = JSON.stringify(await b.tools.browser_click!.execute!({ target: refOf(snap, "Change"), element: "Change" }, ctx));
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(first).not.toContain("too long to check");
      expect(second).toContain("too long to check, or keeps changing it");
      expect(first + second).not.toContain("first-secret-");
    });
  }, 120_000);

  test("a password field that goes back to its own long value from before typing is not treated as too long", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/password-long-before`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), "first-secret-1", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 1500));
      const text = await snapshot(b);
      expect(text).toContain("Back");
      expect(text).not.toContain("withheld");
      expect(await b.screenshot()).not.toBeNull();
    });
  }, 120_000);

  test("a password field the page gives a lone surrogate keeps the browser tools working, with the password masked", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/password-lone-surrogate`);
      expect(await b.fillField(refOf(await snapshot(b), "Password"), "first-secret-1", "password")).toBe("typed the password");
      await new Promise((r) => setTimeout(r, 1500));
      const text = await snapshot(b);
      expect(text).toContain("Odd");
      expect(text).not.toContain("first-secret-");
      expect(text).not.toContain("withheld");
    });
  }, 120_000);

  test("a password the page repeats inside a line of text is masked with its whole line, so its length does not show", async () => {
    const first = await screenshotAfter("short-secret-1", "/echo-inline", async () => undefined);
    const second = await screenshotAfter("a-much-longer-secret-2", "/echo-inline", async () => undefined);
    expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
  }, 120_000);

  test("a password the page repeats in capitals is masked too", async () => {
    const first = await screenshotAfter("first-secret-1", "/echo-upper", async () => undefined);
    const second = await screenshotAfter("other-secret-2", "/echo-upper", async () => undefined);
    expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
  }, 120_000);

  test("a secret the run knows is masked in the forms a page shows it in, such as URL encoding", async () => {
    const shotOf = async (path: string, secret: string) => {
      const scrubber = new SecretScrubber();
      scrubber.add(secret);
      const taken: { shot: Screenshot | null } = { shot: null };
      await withBrowser(async (b) => {
        await navigate(b, `${origin}${path}`);
        taken.shot = await b.screenshot();
      }, { scrubber });
      return Buffer.from(taken.shot?.bytes ?? []);
    };
    const first = await shotOf("/echo-encoded-a", "Alpha&Secret#1111");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotOf("/echo-encoded-b", "Bravo&Secret#2222"))).toBe(0);
  }, 120_000);

  test("when the page cannot be checked for secrets in time, no screenshot is taken rather than an unmasked one", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/two`);
      expect(await b.screenshot()).toBeNull();
    }, { maskCheckMs: 0 });
  }, 60_000);

  test("a page not opened yet, or one waiting on a dialog, gives no screenshot rather than hanging", async () => {
    await withBrowser(async (b) => {
      expect(await b.screenshot()).toBeNull();
      await snapshot(b);
      expect(await b.screenshot()).toBeNull();
      await navigate(b, `${origin}/dialog`);
      const snap = await snapshot(b);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Delete"), element: "delete" }, ctx);
      const started = Date.now();
      expect(await b.screenshot()).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
      await b.tools.browser_handle_dialog!.execute!({ accept: false }, ctx);
    });
  }, 60_000);

  test.each([
    ["keyframes", "a CSS animation"],
    ["waapi", "a script's Web Animation"],
    ["transition", "CSS transitions"],
    ["frame-clock", "a script timed by the frame clock"],
    ["wall-clock", "a script timed by the wall clock"],
  ])("a password on an element moved by %s (%s) gives no screenshot rather than one the masks may miss", async (motion) => {
    expect(await shotsOf(`/moving-${motion}`, 3, typeAndClick("Move"))).toEqual([null, null, null]);
  }, 120_000);

  test("screenshots asked for at once each keep their masks, as Playwright takes a page's screenshots one at a time", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/static-secret`);
      const shots = await Promise.all([b.screenshot(), b.screenshot(), b.screenshot()]);
      expect(shots.every((shot) => shot !== null)).toBe(true);
      expect(await Promise.all(shots.map((shot) => redPixels(shot!)))).toEqual([0, 0, 0]);
    }, knowing("card-secret-1111"));
  }, 60_000);

  test.each([
    ["/scroll-code", "/scroll-code-other", "a code block that scrolls sideways"],
    ["/ellipsis", "/ellipsis-other", "a table cell cut short with an ellipsis"],
  ])("a secret in text the page cuts off, in %s, is masked without blacking out the rest of the page (%s)", async (path, other) => {
    const shotOf = async (at: string) => (await shotsOf(at, 1, async () => undefined, knowing("card-secret-1111")))[0]!;
    const shot = await shotOf(path);
    expect(await redPixels(shot)).toBe(0);
    expect(Buffer.compare(Buffer.from(shot.bytes), Buffer.from((await shotOf(other)).bytes))).not.toBe(0);
  }, 120_000);

  test("after a screenshot the page's animations run on and still obey the page's own styles", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/held-animation`);
      expect(await b.screenshot()).not.toBeNull();
      const snap = await snapshot(b);
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Check"), element: "check" }, ctx);
      await new Promise((r) => setTimeout(r, 400));
      expect(await snapshot(b)).toContain("spinning");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Hold"), element: "hold" }, ctx);
      await new Promise((r) => setTimeout(r, 300));
      expect(await snapshot(b)).toContain("held: paused");
    });
  }, 60_000);

  test("a password shown in a field stays masked while the page keeps adding and removing fields above it", async () => {
    const shots = await shotsOf("/churn", 6, async (b, snap) => {
      expect(await b.fillField(refOf(snap, "Password"), "churn-secret-1", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show" }, ctx);
    });
    const taken = shots.filter((shot): shot is Screenshot => shot !== null);
    expect(taken.length).toBeGreaterThan(0);
    expect(await Promise.all(taken.map(redPixels))).toEqual(taken.map(() => 0));
  }, 120_000);

  test("a password shown in a field is masked even when the page hides the field's value from its own scripts", async () => {
    const shotAfter = async (password: string) => {
      const [shot] = await shotsOf("/hidden-value", 1, async (b, snap) => {
        expect(await b.fillField(refOf(snap, "Password"), password, "password")).toBe("typed the password");
        await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show" }, ctx);
      });
      return Buffer.from(shot?.bytes ?? []);
    };
    const first = await shotAfter("hidden-secret-1");
    expect(first.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(first, await shotAfter("hidden-secret-2"))).toBe(0);
  }, 120_000);

  test("a secret inside a larger block is masked on its own: the heading and the field next to it stay in the picture", async () => {
    const shotOf = async (path: string) => (await shotsOf(path, 1, async () => undefined, knowing("card-secret-1111")))[0]!;
    const base = await shotOf("/card");
    expect(await redPixels(base)).toBe(0);
    expect(Buffer.compare(Buffer.from(base.bytes), Buffer.from((await shotOf("/card-other-heading")).bytes))).not.toBe(0);
    expect(Buffer.compare(Buffer.from(base.bytes), Buffer.from((await shotOf("/card-other-field")).bytes))).not.toBe(0);
  }, 120_000);

  test.each([
    ["/overflowing", "runs outside its box"],
    ["/zero-height", "sits in a box with no height"],
    ["/overflow-edge", "runs just past the edge of the box around its own"],
    ["/tight-line", "has a line height of zero"],
    ["/tight-height", "is taller than its box"],
    ["/tight-width", "is a little wider than its box"],
    ["/clip-one-axis", "is cut off sideways but not below"],
    ["/contents-hidden", "is inside a box-less wrapper that says it hides overflow"],
    ["/inline-hidden", "is inside an inline element that says it hides overflow"],
    ["/clip-margin", "is cut off only past a clip margin"],
    ["/row-hidden", "runs past a table row that says it hides overflow"],
    ["/row-span", "spans rows below the one that says it hides overflow"],
    ["/contents-text", "is in an element with no box of its own"],
    ["/slot-fallback", "is a component slot's fallback"],
    ["/hidden-parent-split", "is partly in a hidden element and partly in a visible child"],
    ["/shadow-split", "is partly in a hidden element and partly in a visible child of its shadow root"],
    ["/shadow-split-nested", "is partly in a hidden element and partly in a visible part of a component inside it"],
    ["/shadow-text", "is text set straight into a component's shadow root"],
    ["/shadow-lit", "is text a template library set into a shadow root between its markers"],
    ["/shadow-groups", "is split into groups inside a shadow root"],
    ["/shadow-split-apart", "is split between a component's own text and its shadow root, far apart"],
    ["/shadow-escaping-part", "is split between a component's own text and a part of its shadow root placed outside the component"],
    ["/escaping-part", "has a part placed outside the box that cuts off the rest"],
    ["/slotted-escaping", "is placed by a component outside its own box, which cuts off everything else"],
    ["/shadow-slot-after", "starts in a component's shadow root and ends in the text it shows through a slot"],
    ["/shadow-slot-named", "starts in a component's shadow root and ends in an element it shows through a named slot"],
    ["/shadow-slot-nested", "ends in a part a component shows through a slot inside its own element, placed far away"],
    ["/contents-relative", "is placed outside a box that cuts off overflow, through a wrapper with no box of its own that says it is positioned"],
    ["/contents-sticky", "is placed outside a box that cuts off overflow, through a wrapper with no box of its own that says it sticks"],
    ["/zero-width", "has zero-width spaces between its parts"],
    ["/soft-hyphen", "has a soft hyphen in it"],
    ["/head-shown", "is in the page's title, which the page's styles show"],
    ["/zero-width-field", "is the value of a field, with a zero-width space in it"],
    ["/direction-mark", "has a left-to-right mark in it"],
    ["/bidi-isolate", "has a part wrapped in bidirectional isolates"],
    ["/grapheme-joiner", "has a combining grapheme joiner in it"],
    ["/invisible-separator", "has an invisible separator in it"],
    ["/script-shown", "is in a script the page's styles show"],
    ["/style-shown", "is in a style sheet the page's styles show"],
    ["/head-contents", "is in the page's title, which the page's styles show through a head with no box"],
  ])("a secret whose text %s is masked where it is drawn (%s)", async (path) => {
    const [shot] = await shotsOf(path, 1, async () => undefined, knowing(path === "/overflow-edge" ? "card-secret-11112" : "card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("text that spills out of its box blacks out only what contains it, not the rest of the page", async () => {
    const shotOf = async (at: string) => (await shotsOf(at, 1, async () => undefined, knowing("card-secret-1111")))[0]!;
    expect(Buffer.compare(Buffer.from((await shotOf("/overflowing")).bytes), Buffer.from((await shotOf("/overflowing-other")).bytes))).not.toBe(0);
  }, 60_000);

  test("a secret the page hides entirely, like one in a collapsed panel, blacks out nothing that is on screen", async () => {
    const shotOf = async (at: string) => (await shotsOf(at, 1, async () => undefined, knowing("card-secret-1111")))[0]!;
    expect(Buffer.compare(Buffer.from((await shotOf("/collapsed")).bytes), Buffer.from((await shotOf("/collapsed-plain")).bytes))).toBe(0);
  }, 60_000);

  test("a secret inside a closed disclosure blacks out nothing that is on screen", async () => {
    const shotOf = async (at: string) => (await shotsOf(at, 1, async () => undefined, knowing("card-secret-1111")))[0]!;
    expect(Buffer.compare(Buffer.from((await shotOf("/closed-details")).bytes), Buffer.from((await shotOf("/closed-details-plain")).bytes))).toBe(0);
  }, 60_000);

  test("a secret drawn where nothing on the page contains it gives no screenshot", async () => {
    expect(await shotsOf("/fixed-below", 1, async () => undefined, knowing("card-secret-1111"))).toEqual([null]);
  }, 60_000);

  test("a secret that starts moving while the screenshot is taken gives no screenshot", async () => {
    expect(await shotsOf("/moves-when-masked", 1, async () => undefined, knowing("card-secret-1111"))).toEqual([null]);
  }, 60_000);

  test("a secret that jumps back and forth by animation gives no screenshot", async () => {
    expect(await shotsOf("/flicker", 5, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null, null, null, null]);
  }, 120_000);

  test("a secret on an element an animation is moving, even one that has not moved for a while, gives no screenshot", async () => {
    expect(await shotsOf("/slow-steps", 2, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null]);
  }, 60_000);

  test("a secret inside a container an animation is moving, even one that has not moved for a while, gives no screenshot", async () => {
    expect(await shotsOf("/flicker-container", 3, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null, null]);
  }, 60_000);

  test("a secret part of which an animation is moving inside it, even slowly, gives no screenshot", async () => {
    expect(await shotsOf("/animated-child", 3, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null, null]);
  }, 60_000);

  test("a secret pushed down by an animation on its container's pseudo-element gives no screenshot", async () => {
    expect(await shotsOf("/pushing-before", 2, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null]);
  }, 60_000);

  test.each(["/shadow-moving-part", "/nested-moving-part", "/moving-component", "/slotted-carried", "/slotted-carried-element", "/slotted-part-moving"])("a secret part of which an animation moves inside a component gives no screenshot (%s)", async (path) => {
    expect(await shotsOf(path, 2, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null]);
  }, 60_000);

  test.each(["/sibling-pusher", "/pusher-elsewhere", "/emphasis-pusher"])("a secret an animation elsewhere on the page can push gives no screenshot (%s)", async (path) => {
    expect(await shotsOf(path, 2, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null]);
  }, 60_000);

  test.each(["/frame-pushed", "/frame-carried", "/frame-nested-carried"])("a secret in a frame that an animation in the page around the frame can move gives no screenshot (%s)", async (path) => {
    expect(await shotsOf(path, 2, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null]);
  }, 60_000);

  test("a secret in an element of a component's shadow root blacks out that element, not the whole component", async () => {
    const shotOf = async (at: string) => (await shotsOf(at, 1, async () => undefined, knowing("card-secret-1111")))[0]!;
    const shot = await shotOf("/shadow-card");
    expect(await redPixels(shot)).toBe(0);
    expect(Buffer.compare(Buffer.from(shot.bytes), Buffer.from((await shotOf("/shadow-card-other")).bytes))).not.toBe(0);
  }, 60_000);

  test.each(["/fixed-progress", "/popover-growing", "/shaking-sibling", "/animated-underline", "/svg-status-dot", "/clip-reveal", "/backdrop-pulse", "/zindex-step", "/emphasis-tint"])("an animation that cannot move the secret keeps the screenshot (%s)", async (path) => {
    const [shot] = await shotsOf(path, 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test.each(["/closed-text", "/closed-groups", "/closed-split", "/closed-slotted", "/closed-slot-after", "/closed-slot-named", "/closed-slot-manual", "/closed-sibling-hosts", "/closed-after-light", "/closed-password", "/closed-typed", "/closed-in-frame", "/closed-long-text", "/closed-zero-width", "/cut-beside-closed", "/cut-empty-beside-closed", "/cut-near-closed", "/closed-flex-parts", "/closed-grid-parts", "/closed-style-shown"])("a secret or password field inside a closed shadow root gives no screenshot (%s)", async (path) => {
    expect(await shotsOf(path, 1, async () => undefined, knowing("card-secret-1111"))).toEqual([null]);
  }, 60_000);

  test("a made-up password that starts on the page and ends inside a closed shadow root gives no screenshot", async () => {
    const scrubber = new SecretScrubber();
    for (let length = MIN_SECRET_LENGTH; length <= "moving-secret-1".length; length++) scrubber.add("moving-secret-1".slice(0, length));
    expect(await shotsOf("/closed-password-tail", 1, async () => undefined, { scrubber })).toEqual([null]);
  }, 60_000);

  test.each(["/phrase-newline", "/phrase-nbsp", "/phrase-double"])("a secret with a space in it is masked however the page spaces it (%s)", async (path) => {
    const [shot] = await shotsOf(path, 1, async () => undefined, knowing("correct horse battery-42"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("a secret stored with a space at its end is masked where the page shows it without one", async () => {
    const [shot] = await shotsOf("/static-secret", 1, async () => undefined, knowing("card-secret-1111 "));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("a secret with a space in it, inside a closed shadow root and spaced differently, gives no screenshot", async () => {
    expect(await shotsOf("/closed-phrase", 1, async () => undefined, knowing("correct horse battery-42"))).toEqual([null]);
  }, 60_000);

  test("a secret in the page's title, which a screen capture does not show, does not stop the screenshot", async () => {
    const [shot] = await shotsOf("/title-secret", 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
  }, 60_000);

  test.each(["/closed-phrase-words", "/cut-spaces-before-closed"])("a secret with words in separate elements, some inside a closed shadow root, gives no screenshot (%s)", async (path) => {
    expect(await shotsOf(path, 1, async () => undefined, knowing("correct horse battery staple"))).toEqual([null]);
  }, 60_000);

  test("a secret with a no-break space, started at the end of a long text and ended inside a closed shadow root, gives no screenshot", async () => {
    expect(await shotsOf("/cut-nbsp-before-closed", 1, async () => undefined, knowing("correct horse battery staple"))).toEqual([null]);
  }, 60_000);

  test("a secret that itself holds a zero-width space is recognised inside a closed shadow root and in a field", async () => {
    expect(await shotsOf("/closed-invisible-needle", 1, async () => undefined, knowing("key\u200bvalue-7777"))).toEqual([null]);
    const [shot] = await shotsOf("/field-invisible-needle", 1, async () => undefined, knowing("key\u200bvalue-7777"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test.each(["/closed-beside-long-text", "/closed-after-long-text"])("a long text away from a closed shadow root keeps the screenshot (%s)", async (path) => {
    const [shot] = await shotsOf(path, 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("a closed shadow root without a secret keeps the screenshot", async () => {
    const [shot] = await shotsOf("/closed-plain", 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("a secret pushed along by an animated element with no text inside its own gives no screenshot", async () => {
    expect(await shotsOf("/pusher", 2, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null]);
  }, 60_000);

  test("a secret moved by an animation on a timeline of the page's own gives no screenshot", async () => {
    expect(await shotsOf("/custom-timeline", 2, async () => undefined, knowing("card-secret-1111"))).toEqual([null, null]);
  }, 60_000);

  test("a large icon spinning beside a secret neither stops the screenshot nor blacks out the rest of the page", async () => {
    const shotOf = async (at: string) => (await shotsOf(at, 1, async () => undefined, knowing("card-secret-1111")))[0];
    const shot = await shotOf("/big-icon");
    expect(shot).not.toBeNull();
    expect(Buffer.compare(Buffer.from(shot!.bytes), Buffer.from((await shotOf("/big-icon-other"))?.bytes ?? []))).not.toBe(0);
  }, 60_000);

  test("a password field an animation is moving, even one that has not moved for a while, gives no screenshot", async () => {
    expect(await shotsOf("/shaking-field", 2, async () => undefined)).toEqual([null, null]);
  }, 60_000);

  test("an animation driven by scrolling does not stop the screenshot while the page stands still", async () => {
    const [shot] = await shotsOf("/scroll-driven", 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test.each([
    ["/badge-beside", "a badge beside it in the same line"],
    ["/decorated-card", "a decoration spinning on its card's pseudo-element"],
    ["/icon-inside", "a spinning icon without text inside its element"],
    ["/delayed-animation", "one still waiting to start"],
    ["/timer-animation", "one with no keyframes, used as a timer"],
    ["/rounded-animation", "one that only rounds corners"],
  ])("an animation around a secret that moves nothing, %s, does not stop the screenshot (%s)", async (path) => {
    const [shot] = await shotsOf(path, 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("an animation that only changes how a field looks, like a glow, does not stop the screenshot", async () => {
    const [shot] = await shotsOf("/glowing-field", 1, async () => undefined);
    expect(shot).not.toBeNull();
  }, 60_000);

  test.each([
    ["/select-list", "a list of options"],
    ["/select-closed", "a closed drop-down"],
    ["/broken-image", "the alternative text of an image that did not load"],
  ])("a secret shown in %s is masked (%s)", async (path) => {
    const [shot] = await shotsOf(path, 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("screenshots leave the page's animation clock where it would have been, neither behind by the time it held still nor running fast", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/clock`);
      for (let i = 0; i < 5; i++) expect(await b.screenshot()).not.toBeNull();
      await new Promise((r) => setTimeout(r, 500));
      await b.tools.browser_click!.execute!({ target: refOf(await snapshot(b), "Clock"), element: "clock" }, ctx);
      const behind = Number(/behind by (-?\d+) ms/.exec(await snapshot(b))?.[1]);
      expect(Math.abs(behind)).toBeLessThan(60);
    });
  }, 60_000);

  test("a page that fakes where its elements are neither stops the screenshot nor moves a mask off a secret", async () => {
    const [shot] = await shotsOf("/boxes-faked", 1, async () => undefined, knowing("card-secret-1111"));
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("what the run looks for never reaches the page's own scripts, even ones that watch everything decoded or matched", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/hooked`);
      const snap = await snapshot(b);
      expect(await b.fillField(refOf(snap, "Password"), "hook-secret-1", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Show password"), element: "show" }, ctx);
      expect(await b.screenshot()).not.toBeNull();
      await b.tools.browser_click!.execute!({ target: refOf(await snapshot(b), "Report"), element: "report" }, ctx);
      expect(await snapshot(b)).toContain("seen 0");
    }, knowing("hook-header-secret-1"));
  }, 60_000);

  test("a password revealed inside a component's shadow root is masked", async () => {
    const [shot] = await shotsOf("/shadow-reveal", 1, async (b, snap) => {
      expect(await b.fillField(refOf(snap, "Password"), "shadow-secret-1", "password")).toBe("typed the password");
      await b.tools.browser_click!.execute!({ target: refOf(snap, "Reveal"), element: "reveal" }, ctx);
    });
    expect(shot).not.toBeNull();
    expect(await redPixels(shot!)).toBe(0);
  }, 60_000);

  test("frames that appear while the screenshot is taken never show a secret unmasked, and once they stop coming every one is masked", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/frames-keep-coming`);
      const coming = [await b.screenshot(), await b.screenshot(), await b.screenshot()].filter((shot): shot is Screenshot => shot !== null);
      expect(await Promise.all(coming.map(redPixels))).toEqual(coming.map(() => 0));
      const started = Date.now();
      while (!(await snapshot(b)).includes("All frames added")) {
        if (Date.now() - started > 30_000) throw new Error("the frames never stopped coming");
        await new Promise((r) => setTimeout(r, 100));
      }
      const settled = await b.screenshot();
      expect(settled).not.toBeNull();
      expect(await redPixels(settled!)).toBe(0);
    }, knowing("card-secret-1111"));
  }, 120_000);

  test("an ordinary page gives a PNG of what is on screen", async () => {
    await withBrowser(async (b) => {
      await navigate(b, `${origin}/two`);
      const shot = await b.screenshot();
      expect(shot?.contentType).toBe("image/png");
      expect(Buffer.from(shot!.bytes).subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(shot!.bytes.byteLength).toBeGreaterThan(1_000);
    });
  }, 60_000);
});
