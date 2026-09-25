import { afterEach, expect, test, vi } from "vitest";
import { GET } from "./route.ts";

afterEach(() => vi.unstubAllEnvs());

test("healthz answers ok with the commit the image was built from, without caching", async () => {
  vi.stubEnv("TRAWLER_COMMIT", "1200dcc4f5779df0707048b9e6c59b758323fb76");
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, commit: "1200dcc4f5779df0707048b9e6c59b758323fb76" });
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("healthz says the commit is unknown when the image was built without one", async () => {
  vi.stubEnv("TRAWLER_COMMIT", "");
  expect(await (await GET()).json()).toEqual({ ok: true, commit: null });
});
