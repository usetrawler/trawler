import type { NodeOptions } from "@sentry/nextjs";
import { DATA_COLLECTION, SENTRY_META, type BrowserSentryConfig } from "../lib/browser-sentry.ts";
import { envScrubber } from "./log.ts";

type Env = Record<string, string | undefined>;

export function serverSentryOptions(env: Env = process.env): NodeOptions | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  const scrubber = envScrubber(env);
  return {
    dsn,
    environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV,
    release: env.TRAWLER_COMMIT || undefined,
    dataCollection: DATA_COLLECTION,
    tracePropagationTargets: [],
    enableRuntimeChannelInjection: false,
    traceLifecycle: "static",
    beforeSend: (event) => scrubber.scrub(event),
    beforeSendTransaction: () => null,
  };
}

export function browserSentryConfig(env: Env = process.env): BrowserSentryConfig | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  return { dsn, environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV, release: env.TRAWLER_COMMIT || undefined };
}

export function sentryMeta(env: Env = process.env): Record<string, string> | undefined {
  const config = browserSentryConfig(env);
  return config ? { [SENTRY_META]: JSON.stringify(config) } : undefined;
}
