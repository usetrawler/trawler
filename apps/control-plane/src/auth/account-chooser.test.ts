import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { createAuth } from "./auth.ts";

const pool = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 1_000 });
afterAll(() => pool.end());
const auth = createAuth({
  pool, secret: "x".repeat(32), baseURL: "http://localhost:3000",
  google: { clientId: "google-id", clientSecret: "google-secret" }, github: { clientId: "github-id", clientSecret: "github-secret" },
});

test.each(["google", "github"] as const)("signing in with %s asks the provider to show its account chooser, so a second account can be picked after sign out", async (provider) => {
  const { url } = await auth.api.signInSocial({ body: { provider, callbackURL: "/" } });
  expect(new URL(url!).searchParams.get("prompt")).toBe("select_account");
});
