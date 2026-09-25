import { afterEach, expect, test, vi } from "vitest";

vi.mock("./db.ts", () => ({ getDb: () => "the database", getKeyring: () => "the keyring" }));

const ENV = {
  DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: "http://localhost:3000", TRAWLER_RUNNER_TOKEN: "r".repeat(40),
  TRAWLER_ARTIFACTS_BUCKET: "trawler-artifacts", TRAWLER_ARTIFACTS_ENDPOINT: "http://127.0.0.1:54339", TRAWLER_ARTIFACTS_REGION: "us-east-1",
  TRAWLER_ARTIFACTS_ACCESS_KEY_ID: "trawler", TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY: "trawler-s3-secret",
};

afterEach(() => vi.unstubAllEnvs());

test("the runner API carries the artifact store when a bucket is configured", async () => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.resetModules();
  const { runnerApiDeps } = await import("./runner-api.ts");
  const { artifactStore } = await import("./artifacts.ts");
  expect(artifactStore()).toBeDefined();
  expect(runnerApiDeps()).toEqual({ db: "the database", keys: "the keyring", runnerToken: "r".repeat(40), artifacts: artifactStore() });
});
