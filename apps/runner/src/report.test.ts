import * as Sentry from "@sentry/node";
import { expect, test } from "vitest";
import { startReporting, workerLog } from "./report.ts";

const RUNNER_TOKEN = "runner-" + "r".repeat(40);

test("a customer's own runner reports nothing, even when their environment has its own SENTRY_DSN", async () => {
  const reporting = startReporting({ SENTRY_DSN: "https://theirs@sentry.test/9" }, [RUNNER_TOKEN]);
  reporting.report("claim failed", { jobId: "job-1" });
  expect(Sentry.getClient()).toBeUndefined();
  await reporting.close();
});

test("the hosted runner reports a failure with its ids, its environment and commit, and without the runner token", async () => {
  const sent: string[] = [];
  const reporting = startReporting({ TRAWLER_SENTRY_DSN: "https://public@sentry.test/2", RAILWAY_ENVIRONMENT_NAME: "staging", TRAWLER_COMMIT: "c0ffee" }, [RUNNER_TOKEN], {
    transport: () => ({
      send: async (envelope: unknown) => {
        if (JSON.stringify(envelope).includes('"type":"event"')) sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  reporting.report(`role_session job-1 finished (error): the control plane refused ${RUNNER_TOKEN}`, { jobId: "job-1", runId: "run-1", kind: "role_session" });
  await reporting.close();
  expect(sent).toHaveLength(1);
  for (const part of ['"job_id":"job-1"', '"run_id":"run-1"', '"kind":"role_session"', '"environment":"staging"', '"release":"c0ffee"', "the control plane refused •••"]) {
    expect(sent[0]).toContain(part);
  }
  expect(sent[0]).not.toContain(RUNNER_TOKEN);
});

test("log lines stay plain text unless TRAWLER_LOG_FORMAT is json, which adds the time, level and ids", () => {
  const lines: string[] = [];
  workerLog({}, (line) => lines.push(line))("role_session job-1 started", { jobId: "job-1", level: "info" });
  workerLog({ TRAWLER_LOG_FORMAT: "json" }, (line) => lines.push(line))("claim failed", { level: "error", jobId: "job-1", runId: "run-1", kind: "judge" });
  workerLog({ TRAWLER_LOG_FORMAT: "json" }, (line) => lines.push(line))("working for https://cp.test");
  expect(lines[0]).toBe("role_session job-1 started");
  expect(JSON.parse(lines[1]!)).toEqual({ time: expect.any(String), level: "error", msg: "claim failed", job_id: "job-1", run_id: "run-1", kind: "judge" });
  expect(Date.parse(JSON.parse(lines[1]!).time)).not.toBeNaN();
  expect(JSON.parse(lines[2]!)).toEqual({ time: expect.any(String), level: "info", msg: "working for https://cp.test" });
});
