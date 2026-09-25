import * as Sentry from "@sentry/nextjs";
import { afterAll, expect, test, vi } from "vitest";
import { register } from "./instrumentation.ts";

const TOKEN = "t".repeat(40);
const original = console.error;
afterAll(async () => {
  console.error = original;
  vi.unstubAllEnvs();
  await Sentry.close();
});

test("outside the Node.js runtime register does nothing", () => {
  vi.stubEnv("NEXT_RUNTIME", "edge");
  vi.stubEnv("SENTRY_DSN", "https://public@sentry.test/1");
  const before = console.error;
  register();
  expect(console.error).toBe(before);
  expect(Sentry.getClient()).toBeUndefined();
});

test("without a DSN register scrubs the console and starts no Sentry", () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("SENTRY_DSN", "");
  vi.stubEnv("TRAWLER_RUNNER_TOKEN", TOKEN);
  const written: unknown[][] = [];
  console.error = (...args: unknown[]) => void written.push(args);
  register();
  console.error(`claim refused for ${TOKEN}`);
  expect(written).toEqual([["claim refused for •••"]]);
  expect(Sentry.getClient()).toBeUndefined();
});

test("with a DSN register starts Sentry with the server options", () => {
  vi.stubEnv("SENTRY_DSN", "https://public@sentry.test/1");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
  register();
  const options = Sentry.getClient()?.getOptions();
  expect(options).toMatchObject({ dsn: "https://public@sentry.test/1", environment: "staging", tracePropagationTargets: [] });
});
