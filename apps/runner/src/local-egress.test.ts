import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openBrowser, SecretScrubber } from "@usetrawler/core";
import { startLocalEgress } from "./local-egress.ts";

const ctx = { toolCallId: "t", messages: [], context: {} };
const accept = (key: string) => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

const servers: http.Server[] = [];
let appPort = 0;
let oidcPort = 0;
let otherPort = 0;
const stolen: string[] = [];

async function serve(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

const steal: http.RequestListener = (req, res) => {
  stolen.push(`${req.headers.host}${req.url}`);
  res.end("stolen");
};

beforeAll(async () => {
  otherPort = (await serve(steal)).port;
  oidcPort = (await serve((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.end(req.url === "/.well-known/openid-configuration" ? '{"issuer":"mock"}' : "");
  })).port;
  const app = await serve((req, res) => {
    if (req.url?.startsWith("/stolen")) return steal(req, res);
    const hop = { "/hop1": "/hop2", "/hop2": `http://127.0.0.1:${otherPort}/stolen`, "/hop3": `http://localhost:${otherPort}/stolen`, "/hop4": "http://169.254.169.254/latest/meta-data/" }[req.url ?? ""];
    if (hop) {
      res.writeHead(302, { location: hop });
      return res.end();
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      res.write("first ");
      setTimeout(() => res.end("second"), 1_500);
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url === "/hops") {
      return res.end(`<title>Hops</title>${["/hop1", "/hop3", "/hop4"].map((h) => `<img src="${h}"><iframe src="${h}"></iframe><script>fetch("${h}").catch(() => undefined)</script>`).join("")}`);
    }
    res.end(`<!doctype html><title>App</title>
<p id="oidc">oidc: waiting</p><p id="hmr">hmr: waiting</p><p id="stream">stream: waiting</p>
<script>
fetch("http://localhost:${oidcPort}/.well-known/openid-configuration").then((r) => r.json()).then(
  (c) => (document.getElementById("oidc").textContent = "oidc: " + c.issuer),
  () => (document.getElementById("oidc").textContent = "oidc: failed"),
);
const ws = new WebSocket("ws://" + location.host + "/_next/webpack-hmr");
ws.onmessage = (e) => (document.getElementById("hmr").textContent = "hmr: " + e.data);
ws.onerror = () => (document.getElementById("hmr").textContent = "hmr: failed");
fetch("/stream").then(async (r) => {
  const reader = r.body.getReader();
  const { value } = await reader.read();
  document.getElementById("stream").textContent = "stream: " + new TextDecoder().decode(value);
});
</script>`);
  });
  app.server.on("upgrade", (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(String(req.headers["sec-websocket-key"]))}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("built")]));
    socket.on("error", () => undefined);
  });
  appPort = app.port;
});
afterAll(() => {
  for (const server of servers) server.close();
});

test("a local run reaches its local target, that target's WebSocket and stream, and a second local origin, and cuts every redirect chain to a local or foreign address", async () => {
  const egress = await startLocalEgress();
  const origins = [`http://localhost:${appPort}`, `http://localhost:${oidcPort}`];
  const blocked: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "trw-local-egress-"));
  try {
    const browser = await egress.browse(origins, (url) => blocked.push(url), (proxy) =>
      openBrowser({ allowedOrigins: origins, outputDir: dir, scrubber: new SecretScrubber(), onBlocked: () => undefined, proxy }));
    try {
      const snapshot = async () => JSON.stringify(await browser.tools.browser_snapshot!.execute!({}, ctx));
      await browser.tools.browser_navigate!.execute!({ url: `http://localhost:${appPort}/` }, ctx);
      let seen = "";
      for (let i = 0; i < 40 && !(seen.includes("oidc: mock") && seen.includes("hmr: built") && seen.includes("stream: first")); i++) {
        await new Promise((r) => setTimeout(r, 250));
        seen = await snapshot();
      }
      expect(seen).toContain("oidc: mock");
      expect(seen).toContain("hmr: built");
      expect(seen).toContain("stream: first");
      expect(seen).not.toContain("stream: first second");

      await browser.tools.browser_navigate!.execute!({ url: `http://localhost:${appPort}/hops` }, ctx);
      for (const hop of ["/hop1", "/hop3", "/hop4"]) await browser.tools.browser_navigate!.execute!({ url: `http://localhost:${appPort}${hop}` }, ctx);
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      await browser.close();
    }
  } finally {
    await egress.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(stolen).toEqual([]);
  expect(blocked).toEqual(expect.arrayContaining([`http://127.0.0.1:${otherPort}`, `http://localhost:${otherPort}`, "http://169.254.169.254"]));
}, 60_000);
