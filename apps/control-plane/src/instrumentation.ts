import * as Sentry from "@sentry/nextjs";
import { scrubConsole } from "@usetrawler/core/secrets";
import type { Instrumentation } from "next";
import { sharedScrubber, writeLog } from "./server/log.ts";
import { serverSentryOptions } from "./server/sentry.ts";

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  scrubConsole(sharedScrubber());
  const options = serverSentryOptions();
  if (options) Sentry.init(options);
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const header = request.headers["x-railway-request-id"] ?? request.headers["x-request-id"];
  const requestId = Array.isArray(header) ? header[0] : header;
  const path = request.path.split(/[?#]/)[0]!;
  const digest = (err as { digest?: unknown }).digest;
  await writeLog("error", "request failed", {
    err, requestId, path, method: request.method, route: context.routePath, route_type: context.routeType, digest: typeof digest === "string" ? digest : undefined,
  });
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("request_id", requestId);
    Sentry.captureRequestError(err, { ...request, path }, context);
  });
};
