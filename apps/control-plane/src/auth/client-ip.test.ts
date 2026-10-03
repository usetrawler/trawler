import { getIP } from "better-auth/api";
import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { createAuth } from "./auth.ts";

const pool = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 1_000 });
afterAll(() => pool.end());
const auth = createAuth({ pool, secret: "x".repeat(32), baseURL: "http://localhost:3000" });

const clientOf = (headers: Record<string, string>) => getIP(new Request("http://localhost:3000/api/auth/sign-in/social", { method: "POST", headers }), auth.options);

test("the client address is the x-real-ip Railway sets, so every person has a sign-in limit of their own", () => {
  expect(clientOf({ "x-real-ip": "203.0.113.5" })).toBe("203.0.113.5");
  expect(clientOf({ "x-real-ip": "198.51.100.7" })).toBe("198.51.100.7");
  expect(clientOf({ "x-real-ip": "2001:db8:abcd:12::1" })).toBe("2001:0db8:abcd:0012:0000:0000:0000:0000");
});

test("an address a visitor puts in x-forwarded-for does not pick their limit", () => {
  expect(clientOf({ "x-forwarded-for": "203.0.113.9" })).not.toBe("203.0.113.9");
  expect(clientOf({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.7" })).toBe("198.51.100.7");
});
