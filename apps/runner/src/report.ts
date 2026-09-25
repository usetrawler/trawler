import type { NodeOptions } from "@sentry/node";
import { MIN_SECRET_LENGTH, scrubConsole, SecretScrubber } from "@usetrawler/core";
import type { LogFields } from "./worker.ts";

type Env = Record<string, string | undefined>;

export interface Reporting {
  report: (message: string, fields: LogFields) => void;
  maskWith: (job: SecretScrubber) => void;
  close: () => Promise<void>;
}

const DATA_COLLECTION: NonNullable<NodeOptions["dataCollection"]> = {
  userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
  graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
  databaseQueryData: false, queues: false, stackFrameVariables: false,
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function fingerprintOf(message: string): string {
  return message.replace(UUID, "<id>").replace(/\d+/g, "<n>").slice(0, 200);
}

export async function startReporting(env: Env, secrets: string[], overrides: Partial<NodeOptions> = {}): Promise<Reporting> {
  const dsn = env.TRAWLER_SENTRY_DSN?.trim();
  if (!dsn) return { report: () => {}, maskWith: () => {}, close: async () => {} };
  const Sentry = await import("@sentry/node");
  const runner = new SecretScrubber();
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) runner.add(secret);
  }
  let jobs: SecretScrubber[] = [];
  const scrubber = { scrub: <T>(value: T): T => runner.scrub(jobs.reduce((masked, job) => job.scrub(masked), value)) };
  scrubConsole(scrubber);
  Sentry.init({
    dsn,
    environment: env.RAILWAY_ENVIRONMENT_NAME || undefined,
    release: env.TRAWLER_COMMIT || undefined,
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    maxBreadcrumbs: 0,
    tracePropagationTargets: [],
    enableRuntimeChannelInjection: false,
    traceLifecycle: "static",
    dataCollection: DATA_COLLECTION,
    beforeSend: (event) => scrubber.scrub(event),
    beforeSendTransaction: () => null,
    ...overrides,
  });
  return {
    report: (message, { jobId, runId, kind }) => {
      const tags = Object.fromEntries(Object.entries({ job_id: jobId, run_id: runId, kind }).filter(([, v]) => v !== undefined));
      const scrubbed = scrubber.scrub(message);
      Sentry.withScope((scope) => {
        scope.setTags(tags);
        scope.setFingerprint(["runner", kind ?? "claim", fingerprintOf(scrubbed)]);
        Sentry.captureException(new Error(scrubbed));
      });
    },
    maskWith: (job) => {
      jobs = [job, ...jobs].slice(0, 2);
    },
    close: async () => {
      await Sentry.close(2000);
    },
  };
}

export function workerLog(env: Env, write: { out: (line: string) => void; err: (line: string) => void }): (line: string, fields?: LogFields) => void {
  if (env.TRAWLER_LOG_FORMAT !== "json") return (line) => write.err(line);
  return (line, { level = "info", jobId, runId, kind } = {}) =>
    (level === "error" ? write.err : write.out)(JSON.stringify({ time: new Date().toISOString(), level, msg: line, job_id: jobId, run_id: runId, kind }));
}
