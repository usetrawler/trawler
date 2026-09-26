import { afterEach, beforeEach, expect, test, vi } from "vitest";

const removals = vi.hoisted(() => [] as unknown[][]);
vi.mock("../artifacts/cleanup.ts", () => ({ removeExpiredArtifacts: async (...args: unknown[]) => void removals.push(args) }));
vi.mock("./db.ts", () => ({ getDb: () => "the database" }));

const BUCKET = {
  TRAWLER_ARTIFACTS_BUCKET: "trawler-artifacts", TRAWLER_ARTIFACTS_ENDPOINT: "http://127.0.0.1:54339", TRAWLER_ARTIFACTS_REGION: "us-east-1",
  TRAWLER_ARTIFACTS_ACCESS_KEY_ID: "trawler", TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY: "trawler-s3-secret",
};

async function fresh() {
  vi.resetModules();
  return import("./artifacts.ts");
}

let logged: string[];

beforeEach(() => {
  logged = [];
  removals.length = 0;
  for (const name of Object.keys(BUCKET)) vi.stubEnv(name, "");
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("an hourly task first runs a minute after start, then every hour; a failure is logged and the next hour runs again", async () => {
  const { repeatHourly } = await fresh();
  vi.useFakeTimers();
  let runs = 0;
  const stop = repeatHourly(async () => {
    runs++;
    if (runs === 2) throw new Error("the bucket is unavailable");
  }, "expired artifacts could not be removed");

  await vi.advanceTimersByTimeAsync(59_999);
  expect(runs).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(runs).toBe(1);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 60_000);
  expect(runs).toBe(2);
  await vi.waitFor(() => expect(logged).toHaveLength(1));
  expect(JSON.parse(logged[0]!)).toMatchObject({ level: "error", msg: "expired artifacts could not be removed", error: { message: "the bucket is unavailable" } });
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(runs).toBe(3);

  stop();
  await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
  expect(runs).toBe(3);
});

test("a task that throws before it returns a promise is logged like any other failure", async () => {
  const { repeatHourly } = await fresh();
  vi.useFakeTimers();
  const stop = repeatHourly((() => {
    throw new Error("no database configured");
  }) as () => Promise<unknown>, "expired artifacts could not be removed");
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(logged).toHaveLength(1));
  expect(JSON.parse(logged[0]!)).toMatchObject({ error: { message: "no database configured" } });
  stop();
});

test("an hour that comes while the last run is still going does not start a second one", async () => {
  const { repeatHourly } = await fresh();
  vi.useFakeTimers();
  let runs = 0;
  let finish = () => {};
  const stop = repeatHourly(() => {
    runs++;
    return new Promise<void>((resolve) => (finish = resolve));
  }, "expired artifacts could not be removed");
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(runs).toBe(1);
  finish();
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(runs).toBe(2);
  stop();
});

test("the cleanup started at boot removes expired artifacts with the configured bucket and the database", async () => {
  for (const [name, value] of Object.entries(BUCKET)) vi.stubEnv(name, value);
  const { artifactStore, startArtifactCleanup } = await fresh();
  vi.useFakeTimers();
  startArtifactCleanup();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(removals).toEqual([["the database", artifactStore()]]);
  expect(artifactStore()).toBeDefined();
  vi.clearAllTimers();
});

test("a half-configured bucket turns artifacts off, starts no cleanup, and says so without repeating it on every call", async () => {
  vi.stubEnv("TRAWLER_ARTIFACTS_BUCKET", "trawler-artifacts");
  const { artifactStore, startArtifactCleanup } = await fresh();
  vi.useFakeTimers();
  expect(artifactStore()).toBeUndefined();
  startArtifactCleanup();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  await vi.waitFor(() => expect(logged).toHaveLength(1));
  expect(JSON.parse(logged[0]!)).toMatchObject({ msg: "artifact storage is misconfigured, so files cannot be stored", error: { message: expect.stringContaining("also needs TRAWLER_ARTIFACTS_ENDPOINT") } });
});
