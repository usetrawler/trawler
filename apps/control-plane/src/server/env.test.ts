import { expect, test } from "vitest";
import { readEnv } from "./env.ts";

const base = { DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: "http://localhost:3000" };

test("reads providers only when both id and secret are set", () => {
  const env = readEnv({ ...base, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "sec", GOOGLE_CLIENT_ID: "only-id" });
  expect(env.github).toEqual({ clientId: "id", clientSecret: "sec" });
  expect(env.google).toBeUndefined();
});

test("names every missing variable and refuses a short secret", () => {
  expect(() => readEnv({})).toThrow("missing environment variables: DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL");
  expect(() => readEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/32 characters/);
});

test("production needs an https address", () => {
  expect(() => readEnv({ ...base, NODE_ENV: "production" })).toThrow(/https/);
  expect(readEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "https://app.usetrawler.com" }).baseURL).toBe("https://app.usetrawler.com");
});

test("the development sign-in can never be enabled in production", () => {
  expect(readEnv({ ...base, TRAWLER_DEV_OIDC_ISSUER: "http://localhost:4500" }).devOidc?.issuer).toBe("http://localhost:4500");
  expect(() => readEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "https://app.usetrawler.com", TRAWLER_DEV_OIDC_ISSUER: "http://localhost:4500" })).toThrow(/never be set in production/);
});

test("a runner token the runner could never send is refused at start", () => {
  expect(readEnv({ ...base, TRAWLER_RUNNER_TOKEN: ` ${"a".repeat(40)}\n` }).runnerToken).toBe("a".repeat(40));
  expect(() => readEnv({ ...base, TRAWLER_RUNNER_TOKEN: "a".repeat(40) + "!@#" })).toThrow(/TRAWLER_RUNNER_TOKEN/);
  expect(() => readEnv({ ...base, TRAWLER_RUNNER_TOKEN: "short" })).toThrow(/TRAWLER_RUNNER_TOKEN/);
});
