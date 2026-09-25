import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import { SecretScrubber } from "@usetrawler/core";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { fingerprintOf, startReporting, workerLog, type Reporting } from "./report.ts";

const RUNNER_TOKEN = "runner-" + "r".repeat(40);
const JOB_PASSWORD = "correct-horse-battery";
const sent: string[] = [];
const everything: string[] = [];
const transport = () => ({
  send: async (envelope: unknown) => {
    everything.push(JSON.stringify(envelope));
    if (JSON.stringify(envelope).includes('"type":"event"')) sent.push(JSON.stringify(envelope));
    return {};
  },
  flush: async () => true,
});
type SentEvent = { tags?: Record<string, string>; exception: { values: Array<{ value: string }> } };
const events = () => sent.map((envelope) => JSON.parse(envelope)[1][0][1] as SentEvent);

test("a customer's own runner reports nothing, even when their environment has its own SENTRY_DSN", async () => {
  const reporting = await startReporting({ SENTRY_DSN: "https://theirs@sentry.test/9" }, [RUNNER_TOKEN]);
  reporting.report("claim failed", { jobId: "job-1" });
  expect(Sentry.getClient()).toBeUndefined();
  await reporting.close();
});

describe("the hosted runner", () => {
  let reporting: Reporting;

  beforeAll(async () => {
    vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "1");
    reporting = await startReporting({ TRAWLER_SENTRY_DSN: "https://public@sentry.test/2", RAILWAY_ENVIRONMENT_NAME: "staging", TRAWLER_COMMIT: "c0ffee" }, [RUNNER_TOKEN], { transport });
    vi.unstubAllEnvs();
  });

  afterAll(() => reporting.close());

  beforeEach(() => {
    sent.length = 0;
    everything.length = 0;
  });

  test("sends errors only: no breadcrumbs, trace headers, sessions, request data or local variables", async () => {
    const client = Sentry.getClient()!;
    const options = client.getOptions() as Sentry.NodeOptions;
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.enableRuntimeChannelInjection).toBe(false);
    for (const name of ["Console", "Http", "NodeFetch", "ProcessSession", "LocalVariablesAsync", "RequestData", "ChildProcess"]) {
      expect(client.getIntegrationByName(name)).toBeUndefined();
    }
    expect(client.getIntegrationByName("OnUnhandledRejection")).toBeDefined();

    reporting.report(`role_session job-1 finished (error): the control plane refused ${RUNNER_TOKEN}`, { jobId: "job-1", runId: "run-1", kind: "role_session" });
    Sentry.captureException(new Error(`an unexpected failure near ${RUNNER_TOKEN}`));
    await Sentry.flush(2000);
    expect(sent).toHaveLength(2);
    const reported = sent.find((envelope) => JSON.parse(envelope)[1][0][1].exception.values[0].value.includes("the control plane refused"))!;
    expect(events().map((e) => e.exception.values[0]!.value)).toEqual(expect.arrayContaining([
      "role_session job-1 finished (error): the control plane refused •••",
      "an unexpected failure near •••",
    ]));
    for (const part of ['"job_id":"job-1"', '"run_id":"run-1"', '"kind":"role_session"', '"environment":"staging"', '"release":"c0ffee"', '"fingerprint":["runner","role_session",']) {
      expect(reported).toContain(part);
    }
    const unexpected = events().find((e) => e.exception.values[0]!.value.startsWith("an unexpected failure"))!;
    expect(unexpected.tags ?? {}).not.toHaveProperty("job_id");
    expect(unexpected.tags ?? {}).not.toHaveProperty("run_id");
    expect(unexpected.tags ?? {}).not.toHaveProperty("kind");
    expect(sent.join("\n")).not.toContain(RUNNER_TOKEN);
  });

  test("sends no span or transaction, even with SENTRY_TRACES_SAMPLE_RATE set in the environment", async () => {
    expect(Sentry.getClient()!.getOptions().tracesSampleRate).toBe(1);
    Sentry.startSpan({ name: `job with ${RUNNER_TOKEN}`, forceTransaction: true }, () => undefined);
    await Sentry.flush(2000);
    expect(everything.filter((envelope) => /"type":"(span|transaction)"/.test(envelope))).toEqual([]);
    expect(everything.join("\n")).not.toContain(RUNNER_TOKEN);
  });

  test("masks an error Sentry catches by itself with the secrets of the job the runner is working on, and of the job before it", async () => {
    const scrubberFor = (secret: string) => {
      const scrubber = new SecretScrubber();
      scrubber.add(secret);
      return scrubber;
    };
    reporting.maskWith(scrubberFor(JOB_PASSWORD));
    reporting.maskWith(scrubberFor("next-job-password"));
    Sentry.captureException(new Error(`the page crashed after typing ${JOB_PASSWORD}`));
    Sentry.captureException(new Error("the next page crashed after typing next-job-password"));
    await Sentry.flush(2000);
    expect(events().map((e) => e.exception.values[0]!.value).sort()).toEqual(["the next page crashed after typing •••", "the page crashed after typing •••"]);
    expect(sent.join("\n")).not.toContain(JOB_PASSWORD);
  });

  test("keeps the secrets of the last two jobs only, so a long-running runner does not scan every job it ever ran", async () => {
    const scrubberFor = (secret: string) => {
      const scrubber = new SecretScrubber();
      scrubber.add(secret);
      return scrubber;
    };
    for (const secret of ["first-job-password", "second-job-password", "third-job-password"]) reporting.maskWith(scrubberFor(secret));
    Sentry.captureException(new Error("typed first-job-password, second-job-password and third-job-password"));
    await Sentry.flush(2000);
    expect(events().map((e) => e.exception.values[0]!.value)).toEqual(["typed first-job-password, ••• and •••"]);
  });
});

test("the same failure of different jobs is one issue, a different failure another", () => {
  const a = fingerprintOf("role_session 11111111-1111-4111-8111-111111111111 finished (error): the browser failed 3 times in a row");
  const b = fingerprintOf("role_session 22222222-2222-4222-8222-222222222222 finished (error): the browser failed 4 times in a row");
  const c = fingerprintOf("role_session 22222222-2222-4222-8222-222222222222 finished (error): the model gave no verdict");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("with a DSN an unhandled promise rejection still stops the hosted runner, and what it prints is masked with the job's secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "reject-"));
  const script = join(dir, "reject.mts");
  const report = fileURLToPath(new URL("./report.ts", import.meta.url));
  const secrets = fileURLToPath(new URL("../../../packages/core/src/secrets.ts", import.meta.url));
  writeFileSync(script, `
    import { SecretScrubber } from ${JSON.stringify(secrets)};
    import { startReporting } from ${JSON.stringify(report)};
    const reporting = await startReporting({ TRAWLER_SENTRY_DSN: "https://public@127.0.0.1:9/2" }, []);
    const job = new SecretScrubber();
    job.add(${JSON.stringify(JOB_PASSWORD)});
    reporting.maskWith(job);
    console.log("reporting started");
    Promise.reject(new Error("nobody caught this after typing " + ${JSON.stringify(JOB_PASSWORD)}));
    setTimeout(() => process.exit(0), 5000);
  `);
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const { status, stdout, stderr } = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: root, encoding: "utf8", timeout: 20_000 });
  expect(stdout).toContain("reporting started");
  expect(status).toBe(1);
  expect(stderr).toContain("nobody caught this after typing •••");
  expect(stderr).not.toContain(JOB_PASSWORD);
});

test("log lines stay plain text on stderr unless TRAWLER_LOG_FORMAT is json, which sends info to stdout and errors to stderr", () => {
  const out: string[] = [];
  const err: string[] = [];
  const write = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  workerLog({}, write)("role_session job-1 started", { jobId: "job-1", level: "info" });
  workerLog({ TRAWLER_LOG_FORMAT: "json" }, write)("working for https://cp.test");
  workerLog({ TRAWLER_LOG_FORMAT: "json" }, write)("claim failed", { level: "error", jobId: "job-1", runId: "run-1", kind: "judge" });
  expect(err[0]).toBe("role_session job-1 started");
  expect(JSON.parse(out[0]!)).toEqual({ time: expect.any(String), level: "info", msg: "working for https://cp.test" });
  expect(JSON.parse(err[1]!)).toEqual({ time: expect.any(String), level: "error", msg: "claim failed", job_id: "job-1", run_id: "run-1", kind: "judge" });
  expect(Date.parse(JSON.parse(err[1]!).time)).not.toBeNaN();
  expect(out).toHaveLength(1);
});
