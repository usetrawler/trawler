import { inspect } from "node:util";
import * as Sentry from "@sentry/nextjs";
import { MIN_SECRET_LENGTH, SecretScrubber } from "@usetrawler/core/secrets";

type Env = Record<string, string | undefined>;

const SECRET_VARIABLES = [
  "BETTER_AUTH_SECRET", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET", "OPENROUTER_API_KEY",
  "TRAWLER_MASTER_KEY", "TRAWLER_RUNNER_TOKEN", "TRAWLER_SMOKE_TOKEN",
];

function databasePasswords(url: string | undefined): string[] {
  if (!url || !URL.canParse(url)) return [];
  const { password } = new URL(url);
  if (!password) return [];
  try {
    return [password, decodeURIComponent(password)];
  } catch {
    return [password];
  }
}

export function envScrubber(env: Env = process.env): SecretScrubber {
  return scrubberWith([], env);
}

export function scrubberWith(extra: Array<string | undefined>, env: Env = process.env): SecretScrubber {
  const scrubber = new SecretScrubber();
  const values = [
    ...SECRET_VARIABLES.map((name) => env[name]),
    ...(env.TRAWLER_PREVIOUS_MASTER_KEYS ?? "").split(","),
    ...databasePasswords(env.DATABASE_URL),
    ...extra,
  ];
  for (const value of values) {
    const secret = value?.trim();
    if (secret && secret.length >= MIN_SECRET_LENGTH) scrubber.add(secret);
  }
  return scrubber;
}

let shared: SecretScrubber | undefined;

export function sharedScrubber(): SecretScrubber {
  shared ??= envScrubber();
  return shared;
}

function scrubbedError(original: Error, scrubber: SecretScrubber): Error {
  const error = new Error(scrubber.scrub(original.message));
  error.name = original.name;
  error.stack = original.stack === undefined ? undefined : scrubber.scrub(original.stack);
  return error;
}

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
let consoleScrubbed = false;

export function scrubConsole(scrubber: SecretScrubber = sharedScrubber()): void {
  if (consoleScrubbed) return;
  consoleScrubbed = true;
  for (const level of CONSOLE_LEVELS) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]) =>
      write(...args.map((arg) => {
        if (typeof arg === "string") return scrubber.scrub(arg);
        if (arg instanceof Error) return scrubbedError(arg, scrubber);
        if (arg !== null && typeof arg === "object") return scrubber.scrub(inspect(arg, { depth: 6 }));
        return arg;
      }));
  }
}

export interface LogFields {
  orgId?: string;
  runId?: string;
  jobId?: string;
  requestId?: string;
  err?: unknown;
  [field: string]: unknown;
}

async function currentRequestId(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    const incoming = await headers();
    return incoming.get("x-railway-request-id") ?? incoming.get("x-request-id") ?? undefined;
  } catch {
    return undefined;
  }
}

function describe(err: unknown): Record<string, unknown> | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { message: String(err) };
}

export async function writeLog(level: "error" | "info", message: string, fields: LogFields = {}, scrubber: SecretScrubber = sharedScrubber()): Promise<Record<string, unknown>> {
  const { orgId, runId, jobId, requestId, err, ...rest } = fields;
  const record = scrubber.scrub({
    time: new Date().toISOString(),
    level,
    msg: message,
    org_id: orgId,
    run_id: runId,
    job_id: jobId,
    request_id: requestId ?? (await currentRequestId()),
    error: describe(err),
    ...rest,
  });
  (level === "error" ? console.error : console.log)(JSON.stringify(record));
  return record;
}

export async function logError(message: string, fields: LogFields = {}, scrubber: SecretScrubber = sharedScrubber()): Promise<void> {
  const record = await writeLog("error", message, fields, scrubber);
  const tags = Object.fromEntries(["org_id", "run_id", "job_id", "request_id"].filter((k) => typeof record[k] === "string").map((k) => [k, record[k] as string]));
  const error = fields.err instanceof Error ? scrubbedError(fields.err, scrubber) : new Error(scrubber.scrub(message));
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    if (!(fields.err instanceof Error)) scope.setFingerprint(["logged", message]);
    scope.addEventProcessor((event) => scrubber.scrub(event));
    Sentry.captureException(error);
  });
}
