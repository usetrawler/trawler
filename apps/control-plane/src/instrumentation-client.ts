import * as Sentry from "@sentry/nextjs";
import { DATA_COLLECTION, readBrowserSentryConfig } from "./lib/browser-sentry.ts";

const config = readBrowserSentryConfig(document);
if (config) Sentry.init({ ...config, dataCollection: DATA_COLLECTION });
