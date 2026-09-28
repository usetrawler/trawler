import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { blockedAddresses } from "@usetrawler/core/network";
import { startEgressProxy, type Resolve } from "./egress-proxy.ts";

const TOKEN = "egress-control-token-".padEnd(40, "x");
const HOSTS: Record<string, string[]> = { "shop.test": ["127.0.0.1"], "rebind.test": ["10.1.2.3"], "mixed.test": ["127.0.0.1", "10.0.0.5"] };
const resolve: Resolve = async (hostname) => {
  const found = HOSTS[hostname];
  if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  return found.map((address) => ({ address, family: 4 }));
};

let upstream: http.Server;
let upstreamPort = 0;
let proxy: Awaited<ReturnType<typeof startEgressProxy>>;

const accept = (key: string) => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

beforeAll(async () => {
  upstream = http.createServer((req, res) => res.end(`hello ${req.url} from ${req.headers.host}${req.headers["proxy-authorization"] ? " with proxy credentials" : ""}`));
  upstream.on("upgrade", (req, socket, head) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(String(req.headers["sec-websocket-key"]))}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.on("data", (data: Buffer) => socket.write(data));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  proxy = await startEgressProxy({ token: TOKEN, resolve, blocked: blockedAddresses({ allowLoopback: true }) });
});
afterAll(async () => {
  await proxy.close();
  upstream.close();
});

async function control(method: string, path: string, body?: unknown, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function session(origins: string[]) {
  const { body } = await control("POST", "/sessions", { origins });
  return { id: body.id as string, port: body.port as number, blocked: async () => (await control("GET", `/sessions/${body.id}/blocked`)).body.blocked };
}

function exchange(port: number, first: string, then?: string): Promise<string> {
  return new Promise((resolveText, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    let sent = false;
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (then && !sent && text.includes("\r\n\r\n") && text.startsWith("HTTP/1.1 200")) {
        sent = true;
        socket.write(then);
      }
      if (text.includes("101 Switching Protocols") && /\r\n\r\nping/.test(text)) {
        socket.destroy();
        resolveText(text);
      }
    });
    socket.on("end", () => resolveText(text));
    socket.on("close", () => resolveText(text));
    socket.on("error", reject);
    socket.setTimeout(3_000, () => socket.destroy(new Error(`no answer; got ${JSON.stringify(text)}`)));
    socket.write(first);
  });
}

const connect = (port: number, target: string, then?: string) => exchange(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, then);
const status = (text: string) => text.split("\r\n")[0];
const get = (host: string, path = "/x") => `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
const upgrade = (host: string) => `GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\nping`;

test("an allowed origin is reached through the session's own port", async () => {
  const s = await session([`https://shop.test:${upstreamPort}`]);
  const target = `shop.test:${upstreamPort}`;
  const through = await connect(s.port, target, get(target));
  expect(status(through)).toBe("HTTP/1.1 200 Connection Established");
  expect(through).toContain(`hello /x from ${target}`);
  expect(await s.blocked()).toEqual([]);
});

test("an allowed host that resolves to a private address, a private address among public ones, and the metadata address are refused and reported", async () => {
  const s = await session([`http://rebind.test:${upstreamPort}`, `http://mixed.test:${upstreamPort}`, "http://169.254.169.254"]);
  expect(status(await connect(s.port, `rebind.test:${upstreamPort}`, get("rebind.test")))).toBe("HTTP/1.1 403 Forbidden");
  expect(status(await connect(s.port, `mixed.test:${upstreamPort}`, get("mixed.test")))).toBe("HTTP/1.1 403 Forbidden");
  expect(status(await connect(s.port, "169.254.169.254:80", get("169.254.169.254")))).toBe("HTTP/1.1 403 Forbidden");
  expect(await s.blocked()).toEqual([
    { url: `http://rebind.test:${upstreamPort}`, reason: "private" },
    { url: `http://mixed.test:${upstreamPort}`, reason: "private" },
    { url: "http://169.254.169.254", reason: "private" },
  ]);
  expect(await s.blocked()).toEqual([]);
});

test("a host outside the session's origins is refused and reported once, raw addresses and other ports included", async () => {
  const s = await session([`https://shop.test:${upstreamPort}`]);
  for (const target of [`127.0.0.1:${upstreamPort}`, `127.0.0.1:${upstreamPort}`, "shop.test:1", "[::1]:443", "unknown.test:443"]) {
    expect(status(await connect(s.port, target, get(target)))).toBe("HTTP/1.1 403 Forbidden");
  }
  expect(await s.blocked()).toEqual([
    { url: `https://127.0.0.1:${upstreamPort}`, reason: "origin" },
    { url: "https://shop.test:1", reason: "origin" },
    { url: "https://[::1]", reason: "origin" },
    { url: "https://unknown.test", reason: "origin" },
  ]);
});

test("a malformed target is refused, and a host that does not resolve is a bad gateway, not a report", async () => {
  HOSTS["gone.test"] = [];
  const s = await session(["https://gone.test", "https://nowhere.test"]);
  expect(status(await connect(s.port, "gone.test"))).toBe("HTTP/1.1 400 Bad Request");
  expect(status(await connect(s.port, "gone.test:99999"))).toBe("HTTP/1.1 400 Bad Request");
  expect(status(await connect(s.port, "gone.test:443"))).toBe("HTTP/1.1 502 Bad Gateway");
  expect(status(await connect(s.port, "nowhere.test:443"))).toBe("HTTP/1.1 502 Bad Gateway");
  expect(await s.blocked()).toEqual([]);
});

test("a plain http request goes only to an allowed origin, without proxy headers", async () => {
  const s = await session([`http://shop.test:${upstreamPort}`, `http://rebind.test:${upstreamPort}`]);
  const ask = (host: string) => exchange(s.port, `GET http://${host}/y HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic eDp5\r\nConnection: close\r\n\r\n`);
  const answer = await ask(`shop.test:${upstreamPort}`);
  expect(status(answer)).toBe("HTTP/1.1 200 OK");
  expect(answer).toContain(`hello /y from shop.test:${upstreamPort}`);
  expect(answer).not.toContain("with proxy credentials");
  expect(status(await ask(`rebind.test:${upstreamPort}`))).toBe("HTTP/1.1 403 Forbidden");
  expect(status(await ask("elsewhere.test"))).toBe("HTTP/1.1 403 Forbidden");
  expect(await s.blocked()).toEqual([{ url: `http://rebind.test:${upstreamPort}`, reason: "private" }, { url: "http://elsewhere.test", reason: "origin" }]);
});

test("a WebSocket reaches an allowed origin, through a tunnel or as a proxied upgrade, and one to a private address is refused", async () => {
  const s = await session([`http://shop.test:${upstreamPort}`, `http://rebind.test:${upstreamPort}`]);
  const tunnelled = await connect(s.port, `shop.test:${upstreamPort}`, upgrade(`shop.test:${upstreamPort}`));
  expect(tunnelled).toContain("HTTP/1.1 101 Switching Protocols");
  expect(tunnelled).toContain("ping");
  const proxied = await exchange(s.port, upgrade(`shop.test:${upstreamPort}`).replace("GET /ws", `GET http://shop.test:${upstreamPort}/ws`));
  expect(status(proxied)).toBe("HTTP/1.1 101 Switching Protocols");
  expect(proxied).toContain("ping");
  expect(status(await connect(s.port, `rebind.test:${upstreamPort}`, upgrade("rebind.test")))).toBe("HTTP/1.1 403 Forbidden");
  expect(await s.blocked()).toEqual([{ url: `http://rebind.test:${upstreamPort}`, reason: "private" }]);
});

test("the control API needs its token and valid origins, and a closed session's port stops listening", async () => {
  expect((await control("GET", "/health", undefined, "wrong-token".padEnd(40, "x"))).status).toBe(401);
  expect((await control("GET", "/health")).status).toBe(200);
  expect((await control("POST", "/sessions", { origins: [] })).status).toBe(400);
  expect((await control("POST", "/sessions", { origins: ["file:///etc/passwd"] })).status).toBe(400);
  expect(await connect(proxy.port, `shop.test:${upstreamPort}`, get("shop.test"))).not.toContain("hello");
  const s = await session([`https://shop.test:${upstreamPort}`]);
  await connect(s.port, "elsewhere.test:443");
  expect(await control("DELETE", `/sessions/${s.id}`)).toEqual({ status: 200, body: { blocked: [{ url: "https://elsewhere.test", reason: "origin" }] } });
  await expect(connect(s.port, `shop.test:${upstreamPort}`)).rejects.toThrow(/ECONNREFUSED/);
  expect((await control("GET", `/sessions/${s.id}/blocked`)).status).toBe(404);
});

test("the proxy will not start with a short control token", async () => {
  await expect(startEgressProxy({ token: "short" })).rejects.toThrow(/at least 32/);
});
