import http, { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockedAddresses, FetchRefused, safeFetchText } from "./safe-fetch.ts";

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
