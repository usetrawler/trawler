import * as Sentry from "@sentry/nextjs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { envScrubber, logError, scrubberWith, writeLog } from "./log.ts";
import { serverSentryOptions } from "./sentry.ts";

const SECRET = "sk-or-v1-" + "5".repeat(48);
const ENV = {
  BETTER_AUTH_SECRET: "a".repeat(40),
  DATABASE_URL: `postgres://trawler_app:${"p".repeat(24)}@postgres.railway.internal:5432/railway`,
  OPENROUTER_API_KEY: SECRET,
  TRAWLER_MASTER_KEY: "bWFzdGVyLWtleS1mb3ItdGVzdHMtMzItYnl0ZXMhIQ==",
  TRAWLER_PREVIOUS_MASTER_KEYS: " b2xkLW1hc3Rlci1rZXktZm9yLXRlc3RzLTMyYnl0ZSE= ,",
  TRAWLER_RUNNER_TOKEN: "r".repeat(40),
  TRAWLER_SMOKE_TOKEN: "s".repeat(40),
  GITHUB_CLIENT_SECRET: "g".repeat(40),
  GOOGLE_CLIENT_SECRET: "o".repeat(40),
};

let lines: string[];
const sent: string[] = [];

beforeAll(() => {
  Sentry.init({
    ...serverSentryOptions({ ...ENV, SENTRY_DSN: "https://public@sentry.test/1", RAILWAY_ENVIRONMENT_NAME: "staging", TRAWLER_COMMIT: "c0ffee" })!,
    transport: () => ({
      send: async (envelope: unknown) => {
        if (JSON.stringify(envelope).includes('"type":"event"')) sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
});

afterAll(() => Sentry.close());

beforeEach(() => {
  lines = [];
  sent.length = 0;
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
});

afterEach(() => vi.restoreAllMocks());

test("every secret the control plane holds is masked, the database password included", () => {
  const scrubber = envScrubber(ENV);
  const text = Object.values(ENV).join(" | ") + ` | ${"p".repeat(24)}`;
  const masked = scrubber.scrub(text);
  for (const secret of [...Object.values(ENV).filter((v) => !v.startsWith("postgres")), "p".repeat(24), "b2xkLW1hc3Rlci1rZXktZm9yLXRlc3RzLTMyYnl0ZSE="]) {
    expect(masked).not.toContain(secret.trim());
  }
  expect(masked).toContain("postgres.railway.internal");
});

test("an error log is one JSON line with its ids and no secret", async () => {
  await writeLog("error", "run could not start", { orgId: "org-1", runId: "run-1", jobId: "job-1", requestId: "req-1", err: new Error(`provider said no to ${SECRET}`), step: "start" }, envScrubber(ENV));
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record).toMatchObject({ level: "error", msg: "run could not start", org_id: "org-1", run_id: "run-1", job_id: "job-1", request_id: "req-1", step: "start", error: { name: "Error" } });
  expect(record.error.message).toBe("provider said no to •••");
  expect(Date.parse(record.time)).not.toBeNaN();
  expect(lines[0]).not.toContain(SECRET);
});

test("a log line outside a request carries no request id and still works", async () => {
  await writeLog("error", "job could not be prepared", { jobId: "job-2" }, envScrubber(ENV));
  const record = JSON.parse(lines[0]!);
  expect(record.job_id).toBe("job-2");
  expect(record).not.toHaveProperty("request_id");
  expect(record).not.toHaveProperty("org_id");
});

test("Sentry collects no user, cookie, header, body, query or local variable data", () => {
  expect(serverSentryOptions({ SENTRY_DSN: "https://public@sentry.test/1" })!.dataCollection).toMatchObject({
    userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false,
  });
});

test("without a DSN Sentry is never started", () => {
  expect(serverSentryOptions({ ...ENV })).toBeUndefined();
  expect(serverSentryOptions({ ...ENV, SENTRY_DSN: "  " })).toBeUndefined();
});

test("a logged error reaches Sentry with its ids as tags and without the secret", async () => {
  await logError("run could not start", { orgId: "org-1", runId: "run-1", err: new Error(`provider said no to ${SECRET}`) }, envScrubber(ENV));
  await Sentry.flush(1000);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('"org_id":"org-1"');
  expect(sent[0]).toContain('"run_id":"run-1"');
  expect(sent[0]).toContain('"environment":"staging"');
  expect(sent[0]).toContain('"release":"c0ffee"');
  expect(sent[0]).toContain("provider said no to •••");
  expect(sent[0]).not.toContain(SECRET);
});

test("a secret only the call knows, like a password being added, is masked in the log line and in Sentry", async () => {
  const password = "hunter2-" + "q".repeat(20);
  const failure = new Error(`duplicate key for account with password ${password}`);
  await logError("account could not be added", { orgId: "org-1", err: failure }, scrubberWith([password], ENV));
  await Sentry.flush(1000);
  expect(lines[0]).toContain("password •••");
  expect(lines[0]).not.toContain(password);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("password •••");
  expect(sent[0]).not.toContain(password);
});
