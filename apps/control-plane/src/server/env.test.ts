import { expect, test } from "vitest";
import { artifactStorage, readEnv } from "./env.ts";

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

test("the OpenRouter address can point at a fake only outside production", () => {
  expect(readEnv(base).openRouterUrl).toBe("https://openrouter.ai/api/v1");
  expect(readEnv({ ...base, TRAWLER_OPENROUTER_URL: "http://localhost:4600/api/v1/" }).openRouterUrl).toBe("http://localhost:4600/api/v1");
  expect(() => readEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "https://app.usetrawler.com", TRAWLER_OPENROUTER_URL: "http://evil.test" })).toThrow(/outside production/);
});

test("hosted runs can be limited to a list of emails", () => {
  expect(readEnv(base).betaEmails).toBeUndefined();
  expect(readEnv({ ...base, TRAWLER_BETA_EMAILS: " Ana@Acme.test, bo@acme.test ,," }).betaEmails).toEqual(["ana@acme.test", "bo@acme.test"]);
});

test("a smoke token that does not look like one is refused wherever the environment is read; without one there is no smoke endpoint", () => {
  expect(readEnv(base).smokeToken).toBeUndefined();
  expect(readEnv({ ...base, TRAWLER_SMOKE_TOKEN: ` ${"s".repeat(48)} ` }).smokeToken).toBe("s".repeat(48));
  expect(() => readEnv({ ...base, TRAWLER_SMOKE_TOKEN: "short" })).toThrow(/TRAWLER_SMOKE_TOKEN/);
});

test("artifact storage is read from its five variables together, path style only when asked, and needs https in production", () => {
  const bucket = {
    TRAWLER_ARTIFACTS_BUCKET: "trawler-artifacts", TRAWLER_ARTIFACTS_ENDPOINT: "https://storage.railway.app", TRAWLER_ARTIFACTS_REGION: "auto",
    TRAWLER_ARTIFACTS_ACCESS_KEY_ID: "key-id", TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY: "key-secret",
  };
  expect(artifactStorage(base)).toBeUndefined();
  expect(artifactStorage({ ...base, ...bucket })).toEqual({ bucket: "trawler-artifacts", endpoint: "https://storage.railway.app", region: "auto", accessKeyId: "key-id", secretAccessKey: "key-secret", pathStyle: false });
  expect(artifactStorage({ ...base, ...bucket, TRAWLER_ARTIFACTS_PATH_STYLE: "true" })?.pathStyle).toBe(true);
  expect(artifactStorage({ ...base, ...bucket, TRAWLER_ARTIFACTS_PATH_STYLE: "false" })?.pathStyle).toBe(false);
  expect(() => artifactStorage({ ...base, ...bucket, TRAWLER_ARTIFACTS_REGION: " ", TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY: "" })).toThrow("artifact storage also needs TRAWLER_ARTIFACTS_REGION, TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY");
  expect(() => artifactStorage({ ...base, ...bucket, TRAWLER_ARTIFACTS_ENDPOINT: "storage.railway.app" })).toThrow(/TRAWLER_ARTIFACTS_ENDPOINT/);
  const production = { ...base, NODE_ENV: "production", BETTER_AUTH_URL: "https://app.usetrawler.com" };
  expect(() => artifactStorage({ ...production, ...bucket, TRAWLER_ARTIFACTS_ENDPOINT: "http://127.0.0.1:54339" })).toThrow(/https in production/);
  expect(artifactStorage({ ...production, ...bucket })?.endpoint).toBe("https://storage.railway.app");
});

test("a half-configured bucket never stops the rest of the app from reading its environment", () => {
  expect(readEnv({ ...base, TRAWLER_ARTIFACTS_BUCKET: "trawler-artifacts" }).databaseUrl).toBe("postgres://x");
});
