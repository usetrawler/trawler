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
