import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/node";
import { expect, test } from "vitest";
import { fingerprintOf, startReporting, workerLog } from "./report.ts";

const RUNNER_TOKEN = "runner-" + "r".repeat(40);
const sent: string[] = [];
const transport = () => ({
  send: async (envelope: unknown) => {
    if (JSON.stringify(envelope).includes('"type":"event"')) sent.push(JSON.stringify(envelope));
    return {};
  },
  flush: async () => true,
});

test("a customer's own runner reports nothing, even when their environment has its own SENTRY_DSN", async () => {
  const reporting = await startReporting({ SENTRY_DSN: "https://theirs@sentry.test/9" }, [RUNNER_TOKEN]);
  reporting.report("claim failed", { jobId: "job-1" });
  expect(Sentry.getClient()).toBeUndefined();
  await reporting.close();
});

test("the hosted runner sends errors only: no breadcrumbs, trace headers, sessions, request data or local variables", async () => {
  const reporting = await startReporting({ TRAWLER_SENTRY_DSN: "https://public@sentry.test/2", RAILWAY_ENVIRONMENT_NAME: "staging", TRAWLER_COMMIT: "c0ffee" }, [RUNNER_TOKEN], { transport });
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
  const exception = (envelope: string): string => JSON.parse(envelope)[1][0][1].exception.values[0].value;
  const reported = sent.find((envelope) => exception(envelope).includes("the control plane refused"))!;
  expect(exception(reported)).toBe("role_session job-1 finished (error): the control plane refused •••");
  for (const part of ['"job_id":"job-1"', '"run_id":"run-1"', '"kind":"role_session"', '"environment":"staging"', '"release":"c0ffee"', '"fingerprint":["runner","role_session",']) {
    expect(reported).toContain(part);
  }
  expect(sent.map(exception)).toContain("an unexpected failure near •••");
  expect(sent.join("\n")).not.toContain(RUNNER_TOKEN);
  await reporting.close();
});

test("the same failure of different jobs is one issue, a different failure another", () => {
  const a = fingerprintOf("role_session 11111111-1111-4111-8111-111111111111 finished (error): the browser failed 3 times in a row");
  const b = fingerprintOf("role_session 22222222-2222-4222-8222-222222222222 finished (error): the browser failed 4 times in a row");
  const c = fingerprintOf("role_session 22222222-2222-4222-8222-222222222222 finished (error): the model gave no verdict");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("with a DSN an unhandled promise rejection still stops the hosted runner, as it does without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "reject-"));
  const script = join(dir, "reject.mts");
  const report = fileURLToPath(new URL("./report.ts", import.meta.url));
  writeFileSync(script, `
    import { startReporting } from ${JSON.stringify(report)};
    await startReporting({ TRAWLER_SENTRY_DSN: "https://public@127.0.0.1:9/2" }, []);
    console.log("reporting started");
    Promise.reject(new Error("nobody caught this"));
    setTimeout(() => process.exit(0), 5000);
  `);
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const { status, stdout } = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: root, encoding: "utf8", timeout: 20_000 });
  expect(stdout).toContain("reporting started");
  expect(status).toBe(1);
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
