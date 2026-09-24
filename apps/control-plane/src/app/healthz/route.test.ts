import { expect, test } from "vitest";
import { GET } from "./route.ts";

test("healthz answers ok without caching", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers.get("cache-control")).toBe("no-store");
});
