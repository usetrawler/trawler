import net from "node:net";
import { expect, test } from "vitest";
import { egressClient } from "./egress-client.ts";

test("waiting for a proxy that never answers gives up with its address", async () => {
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const { port } = closed.address() as net.AddressInfo;
  await new Promise<void>((r) => closed.close(() => r()));
  await expect(egressClient(`http://127.0.0.1:${port}`, "x".repeat(40)).ready(300)).rejects.toThrow(`the egress proxy at http://127.0.0.1:${port} is not answering`);
});
