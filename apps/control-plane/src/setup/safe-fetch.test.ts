import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { createServer as createTcpServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { blockedAddresses, FetchRefused, safeFetchText, guardedFetch } from "./safe-fetch.ts";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/page") return res.end("<h1>Hello</h1>");
    if (req.url === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    if (req.url === "/to-page") {
      res.writeHead(302, { location: "/page" });
      return res.end();
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      return res.end();
    }
    if (req.url === "/big") {
      res.setHeader("content-type", "text/html");
      const chunk = "a".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 20 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => (sent = Infinity));
      return pump();
    }
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 3000);
    if (req.url === "/trickle") {
      const timer = setInterval(() => res.write("a"), 100);
      res.on("close", () => clearInterval(timer));
      return;
    }
    res.statusCode = 404;
    res.end("missing");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const allowLoopback = blockedAddresses({ allowLoopback: true });

describe("refuses private destinations", () => {
  for (const url of ["http://127.0.0.1/", "http://localhost/", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://metadata.google.internal/"]) {
    test(url, async () => {
      await expect(safeFetchText(url)).rejects.toThrow(/not allowed|could not be resolved/);
    });
  }
});

test("refuses other schemes and credentials in the address", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/", "https://user:pw@example.com/"]) {
    await expect(safeFetchText(url)).rejects.toThrow(/http\(s\)/);
  }
});

test("fetches an allowed page and follows allowed redirects", async () => {
  const { text, finalUrl } = await safeFetchText(`${base}/to-page`, { blocked: allowLoopback });
  expect(text).toBe("<h1>Hello</h1>");
  expect(finalUrl).toBe(`${base}/page`);
});

test("a redirect to a private address is refused at the hop", async () => {
  await expect(safeFetchText(`${base}/to-metadata`, { blocked: allowLoopback })).rejects.toThrow(/not allowed/);
});

test("redirect loops, error pages, huge pages and slow pages are handled", async () => {
  await expect(safeFetchText(`${base}/loop`, { blocked: allowLoopback })).rejects.toThrow(/too many redirects/);
  await expect(safeFetchText(`${base}/missing`, { blocked: allowLoopback })).rejects.toThrow(/HTTP 404/);
  const big = await safeFetchText(`${base}/big`, { blocked: allowLoopback });
  expect(big.text.length).toBeLessThanOrEqual(2_000_000);
  await expect(safeFetchText(`${base}/slow`, { blocked: allowLoopback, timeoutMs: 500 })).rejects.toThrow(/timed out/);
  await expect(safeFetchText(`${base}/trickle`, { blocked: allowLoopback, timeoutMs: 800 })).rejects.toThrow(/timed out/);
});

test("a pooled keep-alive socket to a private host is not reused", async () => {
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => http.get(`http://localhost:${port}/page`, (res) => { res.resume(); res.on("end", () => resolve()); }));
  await expect(safeFetchText(`http://localhost:${port}/page`)).rejects.toThrow(/not allowed/);
});

test("very long addresses and embedded private IPv4 forms are refused", async () => {
  await expect(safeFetchText(`https://example.com/?q=${"a".repeat(3000)}`)).rejects.toThrow(/too long/);
  for (const url of ["http://[::127.0.0.1]/", "http://[2002:7f00:1::]/", "http://[64:ff9b:1::7f00:1]/", "http://[fec0::1]/"]) {
    await expect(safeFetchText(url), url).rejects.toThrow(/not allowed/);
  }
});

test("refusals carry a reason code for the user interface", async () => {
  await expect(safeFetchText("http://10.0.0.1/")).rejects.toMatchObject({ reason: "private" });
  await expect(safeFetchText("ftp://x/")).rejects.toBeInstanceOf(FetchRefused);
});

test("allowing loopback for tests still blocks the rest of the IPv4-compatible range", () => {
  const list = blockedAddresses({ allowLoopback: true });
  expect(list.check("::1", "ipv6")).toBe(false);
  expect(list.check("::", "ipv6")).toBe(true);
  expect(list.check("::7f00:1", "ipv6")).toBe(true);
  expect(list.check("::a00:1", "ipv6")).toBe(true);
  expect(blockedAddresses().check("::1", "ipv6")).toBe(true);
});

test("the guarded fetch used for custom model endpoints refuses private and plain-http addresses and does not follow redirects", async () => {
  const guarded = guardedFetch();
  for (const url of ["https://127.0.0.1/v1/models", "https://localhost/v1/models", "https://169.254.169.254/latest", "https://[::1]/v1", "https://10.0.0.5/v1", "http://api.example.com/v1"]) {
    await expect(guarded(url)).rejects.toBeInstanceOf(FetchRefused);
  }
});

describe("answers that cannot become a fetch Response", () => {
  const UPGRADE = "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n";
  const closed = new Map<string, Promise<boolean>>();
  const sent = new Map<string, number>();
  let raw: ReturnType<typeof createTcpServer>;
  let rawBase = "";
  let overPlainTcp: { mockRestore(): void };

  beforeAll(async () => {
    raw = createTcpServer((socket) => socket.once("data", (request) => {
      const path = String(request).split(" ")[1]!;
      const code = path.slice(path.lastIndexOf("/") + 1);
      closed.set(path, new Promise((r) => socket.on("close", () => r(true))));
      socket.on("error", () => {});
      if (path.startsWith("/upgrade/")) return socket.end(UPGRADE);
      if (path.startsWith("/upgrade-open/")) return socket.write(UPGRADE);
      if (path.startsWith("/flood/")) {
        const chunk = "x".repeat(64_000);
        socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n");
        sent.set(path, 0);
        const pump = setInterval(() => {
          if (socket.destroyed) return;
          socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
          sent.set(path, sent.get(path)! + chunk.length);
        }, 2);
        return socket.on("close", () => clearInterval(pump));
      }
      if (path.startsWith("/declared/")) return socket.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 50000000\r\n\r\n{");
      if (path.startsWith("/endless/")) {
        socket.write(`HTTP/1.1 ${code} Odd\r\ntransfer-encoding: chunked\r\n\r\n`);
        const pump = setInterval(() => socket.write("5\r\nhello\r\n"), 20);
        return socket.on("close", () => clearInterval(pump));
      }
      socket.end(`HTTP/1.1 ${code} Odd\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{"data":[]}`);
    }));
    await new Promise<void>((r) => raw.listen(0, "127.0.0.1", r));
    const port = (raw.address() as { port: number }).port;
    rawBase = `http://127.0.0.1:${port}`;
    overPlainTcp = vi.spyOn(https, "request").mockImplementation(((url: URL, options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) =>
      http.request({ host: "127.0.0.1", port, path: url.pathname, method: options.method, headers: options.headers, signal: options.signal, agent: false }, callback)) as unknown as typeof https.request);
  });
  afterAll(() => {
    overPlainTcp.mockRestore();
    raw.close();
  });

  const closesWithin = (path: string, ms: number) => Promise.race([closed.get(path)!, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  test("the guarded fetch refuses such an answer instead of never settling", async () => {
    const guarded = guardedFetch();
    for (const code of [200, 503, 599]) {
      const answered = await guarded(`https://llm.example.com/status/${code}`);
      expect([answered.status, await answered.text()]).toEqual([code, '{"data":[]}']);
    }
    for (const [path, read] of [["/status/999", 999], ["/status/600", 600], ["/status/000", 0], ["/status/205", 205], ["/status/101", 101], ["/upgrade/101", 101]] as const) {
      const refused = await guarded(`https://llm.example.com${path}`).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(FetchRefused);
      expect(refused).toMatchObject({ reason: "status", message: `HTTP ${read}` });
    }
  });

  test("the guarded fetch closes the connection of an answer it refuses", async () => {
    const guarded = guardedFetch();
    for (const path of ["/endless/600", "/endless/999", "/endless/099", "/endless/000", "/endless/101", "/upgrade-open/101"]) {
      await expect(guarded(`https://llm.example.com${path}`)).rejects.toMatchObject({ reason: "status" });
      expect(await closesWithin(path, 2000)).toBe(true);
    }
  });

  test("an answer over the fetch's cap is refused as too large while it streams, and one that declares its size before a byte is read; the connection is closed", async () => {
    const capped = guardedFetch({ maxResponseBytes: 200_000 });
    await expect(capped("https://llm.example.com/flood/1")).rejects.toMatchObject({ reason: "too_long" });
    expect(await closesWithin("/flood/1", 2000)).toBe(true);
    expect(sent.get("/flood/1")).toBeLessThan(2_000_000);
    await expect(capped("https://llm.example.com/declared/1")).rejects.toMatchObject({ reason: "too_long" });
    expect(await closesWithin("/declared/1", 2000)).toBe(true);
    const answered = await capped("https://llm.example.com/status/200");
    expect(await answered.text()).toBe('{"data":[]}');
  });

  test("the chat calls to a custom endpoint are capped at 2 MB, while listing its models keeps the larger cap", async () => {
    const { CHAT_ANSWER_BYTES, chatFetchFor, fetchFor } = await import("../llm/providers.ts");
    expect(CHAT_ANSWER_BYTES).toBe(2_000_000);
    const custom = { provider: "custom" as const, key: "k", baseUrl: "https://llm.example.com/v1" };
    await expect(chatFetchFor(custom)("https://llm.example.com/flood/2")).rejects.toMatchObject({ reason: "too_long" });
    expect(sent.get("/flood/2")).toBeGreaterThan(CHAT_ANSWER_BYTES - 64_000);
    expect(sent.get("/flood/2")).toBeLessThan(CHAT_ANSWER_BYTES * 3);
    await expect(fetchFor(custom)("https://llm.example.com/flood/3")).rejects.toMatchObject({ reason: "too_long" });
    expect(sent.get("/flood/3")).toBeGreaterThan(16_000_000 - 64_000);
    const openRouter = { provider: "openrouter" as const, key: "k", baseUrl: "https://openrouter.ai/api/v1" };
    expect(chatFetchFor(openRouter, fetch)).toBe(fetch);
  });

  test("a page read for setup that answers 101 is refused instead of never settling", async () => {
    await expect(safeFetchText(`${rawBase}/upgrade/101`, { blocked: allowLoopback, timeoutMs: 1000 })).rejects.toMatchObject({ reason: "status", message: "HTTP 101" });
  });
});
