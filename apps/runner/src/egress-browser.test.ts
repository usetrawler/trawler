import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openBrowser, SecretScrubber } from "@usetrawler/core";
import { blockedAddresses } from "@usetrawler/core/network";
import { egressClient } from "./egress-client.ts";
import { startEgressProxy, type Resolve } from "./egress-proxy.ts";

const TOKEN = "egress-browser-test-token".padEnd(40, "x");
const ctx = { toolCallId: "t", messages: [], context: {} };
const accept = (key: string) => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

let shop: http.Server;
let direct: http.Server;
let shopPort = 0;
let directPort = 0;
let proxy: Awaited<ReturnType<typeof startEgressProxy>>;

const page = (privatePort: number) => `<!doctype html><title>Shop</title>
<p id="ws">ws: waiting</p><p id="private">private: waiting</p>
<script>
const ws = new WebSocket("ws://" + location.host + "/ws");
ws.onmessage = (e) => (document.getElementById("ws").textContent = "ws: " + e.data);
ws.onerror = () => (document.getElementById("ws").textContent = "ws: failed");
fetch("http://private.test:${privatePort}/secret").then((r) => r.text()).then(
  (t) => (document.getElementById("private").textContent = "private: " + t),
  () => (document.getElementById("private").textContent = "private: refused"),
);
</script>`;

beforeAll(async () => {
  shop = http.createServer((req, res) => {
    if (req.url === "/secret") return res.end("leaked");
    res.setHeader("content-type", "text/html");
    res.end(page(shopPort));
  });
  shop.on("upgrade", (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(String(req.headers["sec-websocket-key"]))}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("hello")]));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((r) => shop.listen(0, "::1", r));
  shopPort = (shop.address() as AddressInfo).port;
  direct = http.createServer((_req, res) => res.end("direct"));
  await new Promise<void>((r) => direct.listen(0, "127.0.0.1", r));
  directPort = (direct.address() as AddressInfo).port;
  const hosts: Record<string, { address: string; family: number }> = { "shop.test": { address: "::1", family: 6 }, "private.test": { address: "10.9.9.9", family: 4 } };
  const resolve: Resolve = async (hostname) => (hosts[hostname] ? [hosts[hostname]] : Promise.reject(new Error("ENOTFOUND")));
  const blocked = blockedAddresses({ allowLoopback: true });
  blocked.addAddress("127.0.0.1");
  proxy = await startEgressProxy({ token: TOKEN, resolve, blocked });
});
afterAll(async () => {
  await proxy.close();
  shop.close();
  direct.close();
});

test("Chromium reaches an allowed origin and its WebSocket only through the proxy, which refuses private and loopback addresses", async () => {
  const egress = egressClient(`http://127.0.0.1:${proxy.port}`, TOKEN);
  await egress.ready();
  const origins = [`http://shop.test:${shopPort}`, `http://private.test:${shopPort}`, `http://127.0.0.1:${directPort}`];
  const session = await egress.open(origins);
  const dir = mkdtempSync(join(tmpdir(), "trw-egress-"));
  const browser = await openBrowser({ allowedOrigins: origins, outputDir: dir, scrubber: new SecretScrubber(), onBlocked: () => undefined, proxy: session.proxy });
  try {
    const snapshot = async () => JSON.stringify(await browser.tools.browser_snapshot!.execute!({}, ctx));
    await browser.tools.browser_navigate!.execute!({ url: `http://shop.test:${shopPort}/` }, ctx);
    let seen = "";
    for (let i = 0; i < 40 && !(seen.includes("ws: hello") && seen.includes("private: refused")); i++) {
      await new Promise((r) => setTimeout(r, 250));
      seen = await snapshot();
    }
    expect(seen).toContain("ws: hello");
    expect(seen).toContain("private: refused");
    expect(seen).not.toContain("leaked");

    await browser.tools.browser_navigate!.execute!({ url: `http://127.0.0.1:${directPort}/` }, ctx);
    expect(await snapshot()).not.toContain("direct");
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(await session.close()).toEqual([
    { url: `http://private.test:${shopPort}`, reason: "private" },
    { url: `http://127.0.0.1:${directPort}`, reason: "private" },
  ]);
}, 60_000);
