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
  TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY: "k".repeat(40),
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "YWN0aW9ucy1rZXktZm9yLXRlc3RzLTMyLWJ5dGVzISE=",
};

let lines: string[];
const sent: string[] = [];
const everything: string[] = [];
type SentException = { value: string; stacktrace?: { frames?: Array<{ function?: string }> } };
const events = () => sent.map((envelope) => JSON.parse(envelope)[1][0][1] as Record<string, unknown> & { exception: { values: SentException[] } });

beforeAll(() => {
  vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "1");
  Sentry.init({
    ...serverSentryOptions({ ...ENV, SENTRY_DSN: "https://public@sentry.test/1", RAILWAY_ENVIRONMENT_NAME: "staging", NODE_ENV: "production", TRAWLER_COMMIT: "c0ffee" })!,
    transport: () => ({
      send: async (envelope: unknown) => {
        everything.push(JSON.stringify(envelope));
        if (JSON.stringify(envelope).includes('"type":"event"')) sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  vi.unstubAllEnvs();
});

afterAll(() => Sentry.close());

beforeEach(() => {
  lines = [];
  sent.length = 0;
  everything.length = 0;
  Sentry.getIsolationScope().clearBreadcrumbs();
  Sentry.getCurrentScope().clearBreadcrumbs();
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
});

afterEach(() => vi.restoreAllMocks());

test("every secret the control plane holds is masked: each secret variable, previous master keys one by one, and the database password", () => {
  const scrubber = envScrubber(ENV);
  const secrets = Object.entries(ENV).filter(([name]) => name !== "DATABASE_URL" && name !== "TRAWLER_PREVIOUS_MASTER_KEYS");
  expect(secrets.map(([name]) => name)).toContain("TRAWLER_MASTER_KEY");
  for (const [name, value] of secrets) expect(scrubber.scrub(`${name} is ${value}.`)).toBe(`${name} is •••.`);
  for (const secret of [OLD_KEY, OLDER_KEY, "p".repeat(24)]) expect(scrubber.scrub(`reached postgres.railway.internal with ${secret}`)).toBe("reached postgres.railway.internal with •••");
});

test("a percent-encoded database password is masked as written in the URL and as the database receives it", () => {
  const scrubber = envScrubber({ DATABASE_URL: "postgres://app:p%40ss-w0rd%2F12@db.test:5432/app" });
  expect(scrubber.scrub("url p%40ss-w0rd%2F12, password p@ss-w0rd/12")).toBe("url •••, password •••");
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

test("no span or transaction leaves, even with SENTRY_TRACES_SAMPLE_RATE set in the environment", async () => {
  expect(Sentry.getClient()!.getOptions().tracesSampleRate).toBe(1);
  Sentry.startSpan({ name: `GET /api/auth/callback/github?code=${SECRET}`, forceTransaction: true }, () => undefined);
  await Sentry.flush(1000);
  expect(everything.filter((envelope) => /"type":"(span|transaction)"/.test(envelope))).toEqual([]);
  expect(everything.join("\n")).not.toContain(SECRET);
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

function unreachableProvider(): Error {
  return new Error("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET}.test`), { code: "ENOTFOUND" }) });
}

test("a logged error keeps its cause and where it was thrown, in the log line and in Sentry, with no secret", async () => {
  await logError("setup failed", { orgId: "org-1", err: unreachableProvider() }, envScrubber(ENV));
  await Sentry.flush(1000);
  const record = JSON.parse(lines[0]!);
  expect(record.error).toMatchObject({ name: "Error", message: "fetch failed", cause: { name: "Error", message: "getaddrinfo ENOTFOUND •••.test" } });
  expect(record.error.stack).toContain("at unreachableProvider ");
  const values = events()[0]!.exception.values;
  expect(values.map((v) => v.value)).toEqual(["getaddrinfo ENOTFOUND •••.test", "fetch failed"]);
  expect(values.at(-1)!.stacktrace!.frames!.map((f) => f.function)).toContain("unreachableProvider");
  expect(sent[0]).not.toContain(SECRET);
  expect(lines[0]).not.toContain(SECRET);
});

test("an error whose cause leads back to itself is logged with a bounded chain of causes", async () => {
  const loop = new Error("retrying");
  loop.cause = loop;
  await writeLog("error", "gave up", { err: loop }, envScrubber(ENV));
  let depth = 0;
  for (let cause = JSON.parse(lines[0]!).error; cause; cause = cause.cause) depth++;
  expect(depth).toBe(6);
});

test("a failure logged without an error object is its own Sentry issue", async () => {
  await logError("run could not be cancelled", { orgId: "org-1" }, envScrubber(ENV));
  await Sentry.flush(1000);
  expect(events()[0]).toMatchObject({ fingerprint: ["logged", "run could not be cancelled"] });
});
