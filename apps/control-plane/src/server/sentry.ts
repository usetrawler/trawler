import type { NodeOptions } from "@sentry/nextjs";
import { DATA_COLLECTION } from "../lib/browser-sentry.ts";
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
    beforeSend: (event) => scrubber.scrub(event),
    beforeBreadcrumb: (breadcrumb) => scrubber.scrub(breadcrumb),
  };
}

export function browserSentryConfig(env: Env = process.env): { dsn: string; environment?: string; release?: string } | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  return { dsn, environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV, release: env.TRAWLER_COMMIT || undefined };
}
