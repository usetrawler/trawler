import { createServer, type Server, type Socket } from "node:net";
import { afterAll, expect, test } from "vitest";
import { s3Store } from "./store.ts";

let silent: Server;
const sockets: Socket[] = [];
afterAll(() => {
  for (const socket of sockets) socket.destroy();
  return new Promise<void>((resolve) => silent.close(() => resolve()));
});

test("a bucket that accepts the connection but never answers fails the call within the request timeout", async () => {
  silent = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const { port } = silent.address() as { port: number };
  const store = s3Store({ bucket: "b", endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", accessKeyId: "a", secretAccessKey: "s", pathStyle: true }, { requestMs: 200 });
  const started = Date.now();
  await expect(store.put("k", new Uint8Array([1]), "image/png")).rejects.toThrow();
  await expect(store.remove("k")).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(4_000);
});
