import * as Sentry from "@sentry/nextjs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { envScrubber, logError, scrubberWith, writeLog } from "./log.ts";
import { serverSentryOptions } from "./sentry.ts";

const SECRET = "sk-or-v1-" + "5".repeat(48);
const OLD_KEY = "b2xkLW1hc3Rlci1rZXktZm9yLXRlc3RzLTMyYnl0ZSE=";
const OLDER_KEY = "b2xkZXItbWFzdGVyLWtleS1mb3ItdGVzdHMtMzJieXQ=";
const ENV = {
  BETTER_AUTH_SECRET: "a".repeat(40),
  DATABASE_URL: `postgres://trawler_app:${"p".repeat(24)}@postgres.railway.internal:5432/railway`,
  OPENROUTER_API_KEY: SECRET,
  TRAWLER_MASTER_KEY: "bWFzdGVyLWtleS1mb3ItdGVzdHMtMzItYnl0ZXMhIQ==",
  TRAWLER_PREVIOUS_MASTER_KEYS: ` ${OLD_KEY} ,${OLDER_KEY},`,
  TRAWLER_RUNNER_TOKEN: "r".repeat(40),
  TRAWLER_SMOKE_TOKEN: "s".repeat(40),
  GITHUB_CLIENT_SECRET: "g".repeat(40),
  GOOGLE_CLIENT_SECRET: "o".repeat(40),
};

let lines: string[];
const sent: string[] = [];
const events = () => sent.map((envelope) => JSON.parse(envelope)[1][0][1] as Record<string, unknown> & { exception: { values: Array<{ value: string }> } });

beforeAll(() => {
  Sentry.init({
    ...serverSentryOptions({ ...ENV, SENTRY_DSN: "https://public@sentry.test/1", RAILWAY_ENVIRONMENT_NAME: "staging", NODE_ENV: "production", TRAWLER_COMMIT: "c0ffee" })!,
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
  Sentry.getIsolationScope().clearBreadcrumbs();
  Sentry.getCurrentScope().clearBreadcrumbs();
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
});

afterEach(() => vi.restoreAllMocks());

test("every secret the control plane holds is masked: previous master keys one by one, and the database password", () => {
  const masked = envScrubber(ENV).scrub(`${Object.values(ENV).filter((v) => !v.startsWith("postgres") && !v.includes(",")).join(" | ")}|${OLDER_KEY}|${"p".repeat(24)}|`);
  for (const secret of [SECRET, "a".repeat(40), "r".repeat(40), "s".repeat(40), "g".repeat(40), "o".repeat(40), OLDER_KEY, "p".repeat(24)]) {
    expect(masked).not.toContain(secret);
  }
  expect(envScrubber(ENV).scrub(`reached postgres.railway.internal with ${OLD_KEY}`)).toBe("reached postgres.railway.internal with •••");
});

test("a database password pg accepts but that is not valid percent-encoding is masked instead of breaking every log call", () => {
  const scrubber = envScrubber({ DATABASE_URL: "postgres://app:ab%zz12345678@db.test:5432/app" });
  expect(scrubber.scrub("connect failed for ab%zz12345678")).toBe("connect failed for •••");
});

test("an error log is one JSON line with its ids and no secret", async () => {
  await writeLog("error", "run could not start", { orgId: "org-1", runId: "run-1", jobId: "job-1", requestId: "req-1", err: new Error(`provider said no to ${SECRET}`), step: "start" }, envScrubber(ENV));
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!);
  expect(record).toMatchObject({ level: "error", msg: "run could not start", org_id: "org-1", run_id: "run-1", job_id: "job-1", request_id: "req-1", step: "start", error: { name: "Error" } });
  expect(record.error.message).toBe("provider said no to •••");
  expect(record.error.stack).toContain("provider said no to •••");
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

test("Sentry sends errors only: nothing about users, cookies, headers, bodies, queries or local variables, no trace headers, no transactions", () => {
  const options = serverSentryOptions({ SENTRY_DSN: "https://public@sentry.test/1" })!;
  expect(options.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false });
  expect(options.tracePropagationTargets).toEqual([]);
  expect(options.enableRuntimeChannelInjection).toBe(false);
  expect(options.beforeSendTransaction!({ type: "transaction" }, {})).toBeNull();
});

test("without a DSN Sentry is never started", () => {
  expect(serverSentryOptions({ ...ENV })).toBeUndefined();
  expect(serverSentryOptions({ ...ENV, SENTRY_DSN: "  " })).toBeUndefined();
});

test("a logged error reaches Sentry with its ids as tags, the Railway environment rather than NODE_ENV, and no secret", async () => {
  await logError("run could not start", { orgId: "org-1", runId: "run-1", err: new Error(`provider said no to ${SECRET}`) }, envScrubber(ENV));
  await Sentry.flush(1000);
  expect(sent).toHaveLength(1);
  expect(events()[0]).toMatchObject({ tags: { org_id: "org-1", run_id: "run-1" }, environment: "staging", release: "c0ffee" });
  expect(events()[0]!.exception.values[0]!.value).toBe("provider said no to •••");
  expect(sent[0]).not.toContain(SECRET);
});

test("an error captured anywhere else, and the breadcrumbs sent with it, are masked by beforeSend alone", async () => {
  Sentry.addBreadcrumb({ category: "console", message: `connecting with ${"r".repeat(40)}` });
  Sentry.captureException(new Error(`uncaught near ${SECRET}`));
  await Sentry.flush(1000);
  expect(sent).toHaveLength(1);
  expect(events()[0]!.exception.values[0]!.value).toBe("uncaught near •••");
  expect(JSON.stringify(events()[0]!.breadcrumbs)).toContain("connecting with •••");
  expect(sent[0]).not.toContain(SECRET);
  expect(sent[0]).not.toContain("r".repeat(40));
});

test("a secret only the call knows, like a password being added, is masked in the log line and everywhere in the Sentry event", async () => {
  const password = "hunter2-" + "q".repeat(20);
  Sentry.addBreadcrumb({ category: "console", message: `inserting an account with ${password}` });
  await logError("account could not be added", { orgId: "org-1", err: new Error(`duplicate key for account with password ${password}`) }, scrubberWith([password], ENV));
  await Sentry.flush(1000);
  expect(lines[0]).toContain("password •••");
  expect(lines[0]).not.toContain(password);
  expect(sent).toHaveLength(1);
  expect(events()[0]!.exception.values[0]!.value).toBe("duplicate key for account with password •••");
  expect(JSON.stringify(events()[0]!.breadcrumbs)).toContain("inserting an account with •••");
  expect(sent[0]).not.toContain(password);
});

test("a failure logged without an error object is its own Sentry issue", async () => {
  await logError("run could not be cancelled", { orgId: "org-1" }, envScrubber(ENV));
  await Sentry.flush(1000);
  expect(events()[0]).toMatchObject({ fingerprint: ["logged", "run could not be cancelled"] });
});
