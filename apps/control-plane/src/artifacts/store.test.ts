import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { s3Store } from "./store.ts";

const sockets: Socket[] = [];
const closed = new Set<Socket>();
const silent = createServer((socket) => {
  sockets.push(socket);
  socket.resume();
  socket.on("close", () => closed.add(socket));
});
let endpoint = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  closed.clear();
});

afterAll(() => new Promise<void>((resolve) => silent.close(() => resolve())));

const silentBucket = () => ({ bucket: "b", endpoint, region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", pathStyle: true });

async function within(ms: number, check: () => boolean): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!check() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  return check();
}

test("a bucket that accepts the connection but never answers fails the call within the request timeout", async () => {
  const store = s3Store(silentBucket(), { requestMs: 200 });
  const started = Date.now();
  await expect(store.put("k", new Uint8Array([1]), "image/png")).rejects.toThrow();
  await expect(store.remove("k")).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(4_000);
});

test("a bucket call is tried three times, whatever AWS_MAX_ATTEMPTS says, so a failing upload always ends well within the cleanup's grace period", async () => {
  vi.stubEnv("AWS_MAX_ATTEMPTS", "8");
  const store = s3Store(silentBucket(), { requestMs: 100 });
  await expect(store.put("k", new Uint8Array([1]), "image/png")).rejects.toThrow();
  expect(sockets).toHaveLength(3);
});

test("removing a file the bucket no longer has succeeds, as S3 answers, while a missing bucket is still an error", async () => {
  const missing = createHttpServer((req, res) => {
    const code = req.url?.includes("/gone/") ? "NoSuchBucket" : "NoSuchKey";
    res.writeHead(404, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>not here</Message></Error>`);
  });
  await new Promise<void>((resolve) => missing.listen(0, "127.0.0.1", resolve));
  try {
    const at = `http://127.0.0.1:${(missing.address() as { port: number }).port}`;
    await expect(s3Store({ ...silentBucket(), endpoint: at }).remove("orgs/o/runs/r/a.png")).resolves.toBeUndefined();
    await expect(s3Store({ ...silentBucket(), endpoint: at, bucket: "gone" }).remove("orgs/o/runs/r/a.png")).rejects.toMatchObject({ name: "NoSuchBucket" });
  } finally {
    await new Promise<void>((resolve) => missing.close(() => resolve()));
  }
});

test("by default a bucket that never answers gets thirty seconds before the call gives up on it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const store = s3Store(silentBucket());
  void store.put("k", new Uint8Array([1]), "image/png").catch(() => undefined);
  expect(await within(2_000, () => sockets.length === 1)).toBe(true);
  const first = sockets[0]!;

  await vi.advanceTimersByTimeAsync(29_999);
  expect(await within(100, () => closed.has(first))).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  expect(await within(2_000, () => closed.has(first))).toBe(true);
});
