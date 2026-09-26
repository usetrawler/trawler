import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { register } from "./instrumentation.ts";

const TOKEN = "t".repeat(40);
const ARTIFACT_VARIABLES = ["TRAWLER_ARTIFACTS_BUCKET", "TRAWLER_ARTIFACTS_ENDPOINT", "TRAWLER_ARTIFACTS_REGION", "TRAWLER_ARTIFACTS_ACCESS_KEY_ID", "TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY"];
const original = console.error;
beforeEach(() => {
  for (const name of ARTIFACT_VARIABLES) vi.stubEnv(name, "");
});
afterAll(async () => {
  console.error = original;
  vi.unstubAllEnvs();
  await Sentry.close();
});

test("outside the Node.js runtime register does nothing", async () => {
  vi.stubEnv("NEXT_RUNTIME", "edge");
  vi.stubEnv("SENTRY_DSN", "https://public@sentry.test/1");
  const before = console.error;
  await register();
  expect(console.error).toBe(before);
  expect(Sentry.getClient()).toBeUndefined();
});

test("without a DSN register scrubs the console and starts no Sentry", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("SENTRY_DSN", "");
  vi.stubEnv("TRAWLER_RUNNER_TOKEN", TOKEN);
  const written: unknown[][] = [];
  console.error = (...args: unknown[]) => void written.push(args);
  await register();
  console.error(`claim refused for ${TOKEN}`);
  expect(written).toEqual([["claim refused for •••"]]);
  expect(Sentry.getClient()).toBeUndefined();
});

test("with a DSN register starts Sentry with the server options", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("SENTRY_DSN", "https://public@sentry.test/1");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
  await register();
  const options = Sentry.getClient()?.getOptions();
  expect(options).toMatchObject({ dsn: "https://public@sentry.test/1", environment: "staging", tracePropagationTargets: [] });
});

test("register scrubs the console before it starts Sentry, so what Sentry prints about an unhandled rejection is masked too", () => {
  const script = join(mkdtempSync(join(tmpdir(), "register-")), "reject.mts");
  const instrumentation = fileURLToPath(new URL("./instrumentation.ts", import.meta.url));
  writeFileSync(script, `
    import { register } from ${JSON.stringify(instrumentation)};
    register();
    console.log("registered");
    Promise.reject(new Error("rejected with " + process.env.TRAWLER_RUNNER_TOKEN));
    setTimeout(() => process.exit(0), 1000);
  `);
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const env = { ...process.env, ...Object.fromEntries(ARTIFACT_VARIABLES.map((name) => [name, ""])), NEXT_RUNTIME: "nodejs", SENTRY_DSN: "http://public@127.0.0.1:9/1", TRAWLER_RUNNER_TOKEN: TOKEN };
  const { stdout, stderr } = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  expect(stdout).toContain("registered");
  expect(stderr).toContain("rejected with •••");
  expect(stderr).not.toContain(TOKEN);
}, 20_000);

test("register starts the hourly removal of expired artifacts only where artifact storage is configured", async () => {
  vi.useFakeTimers();
  try {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("SENTRY_DSN", "");
    await register();
    expect(vi.getTimerCount()).toBe(0);
    for (const [name, value] of Object.entries({
      TRAWLER_ARTIFACTS_BUCKET: "trawler-artifacts", TRAWLER_ARTIFACTS_ENDPOINT: "http://127.0.0.1:54339", TRAWLER_ARTIFACTS_REGION: "us-east-1",
      TRAWLER_ARTIFACTS_ACCESS_KEY_ID: "trawler", TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY: "trawler-s3-secret",
    })) vi.stubEnv(name, value);
    await register();
    expect(vi.getTimerCount()).toBe(2);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
