import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { writeLog } from "./server/log.ts";
import { serverSentryOptions } from "./server/sentry.ts";

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const options = serverSentryOptions();
  if (options) Sentry.init(options);
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const id = request.headers["x-railway-request-id"] ?? request.headers["x-request-id"];
  await writeLog("error", "request failed", {
    err, requestId: Array.isArray(id) ? id[0] : id, path: request.path, method: request.method, route: context.routePath, route_type: context.routeType,
  });
  Sentry.captureRequestError(err, request, context);
};
