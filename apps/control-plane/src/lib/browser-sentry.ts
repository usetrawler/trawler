import type { BrowserOptions } from "@sentry/nextjs";

export interface BrowserSentryConfig {
  dsn: string;
  environment?: string;
  release?: string;
}

export const SENTRY_META = "trawler-sentry";

export const DATA_COLLECTION: NonNullable<BrowserOptions["dataCollection"]> = {
  userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
  graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
  databaseQueryData: false, queues: false, stackFrameVariables: false,
};

interface Page {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

export function readBrowserSentryConfig(page: Page): BrowserSentryConfig | undefined {
  const content = page.querySelector(`meta[name="${SENTRY_META}"]`)?.getAttribute("content");
  if (!content) return undefined;
  try {
    const config = JSON.parse(content) as Partial<BrowserSentryConfig>;
    if (typeof config.dsn !== "string" || !config.dsn) return undefined;
    return { dsn: config.dsn, environment: config.environment, release: config.release };
  } catch {
    return undefined;
  }
}
