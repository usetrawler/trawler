import * as Sentry from "@sentry/node";
import { MIN_SECRET_LENGTH, SecretScrubber } from "@usetrawler/core";
import type { LogFields } from "./worker.ts";

type Env = Record<string, string | undefined>;

export interface Reporting {
  report: (message: string, fields: LogFields) => void;
  close: () => Promise<void>;
}

const DATA_COLLECTION: NonNullable<Sentry.NodeOptions["dataCollection"]> = {
  userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
  graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
  databaseQueryData: false, queues: false, stackFrameVariables: false,
};

export function startReporting(env: Env, secrets: string[], overrides: Partial<Sentry.NodeOptions> = {}): Reporting {
  const dsn = env.TRAWLER_SENTRY_DSN?.trim();
  if (!dsn) return { report: () => {}, close: async () => {} };
  const scrubber = new SecretScrubber();
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) scrubber.add(secret);
  }
  Sentry.init({
    dsn,
    environment: env.RAILWAY_ENVIRONMENT_NAME || undefined,
    release: env.TRAWLER_COMMIT || undefined,
    dataCollection: DATA_COLLECTION,
    beforeSend: (event) => scrubber.scrub(event),
    beforeBreadcrumb: (breadcrumb) => scrubber.scrub(breadcrumb),
    ...overrides,
  });
  return {
    report: (message, { jobId, runId, kind }) => {
      const tags = Object.fromEntries(Object.entries({ job_id: jobId, run_id: runId, kind }).filter(([, v]) => v !== undefined));
      Sentry.captureException(new Error(scrubber.scrub(message)), { tags });
    },
    close: async () => {
      await Sentry.close(2000);
    },
  };
}

export function workerLog(env: Env, write: (line: string) => void): (line: string, fields?: LogFields) => void {
  if (env.TRAWLER_LOG_FORMAT !== "json") return (line) => write(line);
  return (line, { level = "info", jobId, runId, kind } = {}) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, msg: line, job_id: jobId, run_id: runId, kind }));
}
