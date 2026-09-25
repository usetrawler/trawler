import * as Sentry from "@sentry/nextjs";
import { browserSentryOptions, readBrowserSentryConfig } from "./lib/browser-sentry.ts";

const config = readBrowserSentryConfig(document);
if (config) Sentry.init(browserSentryOptions(config));
