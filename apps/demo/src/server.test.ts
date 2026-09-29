import { afterAll, beforeAll, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { demoServer } from "./server.ts";
import { ACCOUNTS } from "./shop.ts";

const server = demoServer();
let base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("over real HTTP a person signs in, keeps the session cookie and reaches the shop; the health check answers", async () => {
  expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  const signIn = await fetch(`${base}/sign-in`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
    body: new URLSearchParams({ email: "lee@greenhouse.test", password: ACCOUNTS["lee@greenhouse.test"]!.password, next: "/shop" }),
  });
  expect(signIn.status).toBe(303);
  const cookie = signIn.headers.get("set-cookie")!;
  expect(cookie).toContain("; Secure");
  const shop = await fetch(`${base}/shop`, { headers: { cookie: cookie.split(";")[0]! } });
  expect(shop.status).toBe(200);
  expect(await shop.text()).toContain("Hi, Lee");
});

test("a request larger than 32 KB is refused before it is read in full", async () => {
  const res = await fetch(`${base}/healthz`, { method: "POST", body: "a".repeat(40_000) });
  expect(res.status).toBe(413);
});
