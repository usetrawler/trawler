import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { onRequestError } from "./instrumentation.ts";
import { readBrowserSentryConfig } from "./lib/browser-sentry.ts";
import { browserSentryConfig } from "./server/sentry.ts";

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
});

afterEach(() => vi.restoreAllMocks());

test("an error while serving a request is logged as JSON with the path, the kind of route and Railway's request id", async () => {
  vi.stubEnv("TRAWLER_RUNNER_TOKEN", "r".repeat(40));
  await onRequestError(
    new Error(`render failed near ${"r".repeat(40)}`),
    { path: "/projects/abc", method: "POST", headers: { "x-railway-request-id": "rr-42" } },
    { routerKind: "App Router", routePath: "/projects/[id]", routeType: "action", renderSource: "react-server-components", revalidateReason: undefined },
  );
  vi.unstubAllEnvs();
  const record = JSON.parse(lines.at(-1)!);
  expect(record).toMatchObject({ level: "error", msg: "request failed", path: "/projects/abc", method: "POST", route: "/projects/[id]", route_type: "action", request_id: "rr-42" });
  expect(record.error.message).toBe("render failed near •••");
});

test("the browser starts Sentry only when the page carries a DSN", () => {
  const page = (content: string | null) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) });
  expect(readBrowserSentryConfig(page(null))).toBeUndefined();
  expect(readBrowserSentryConfig(page("not json"))).toBeUndefined();
  expect(readBrowserSentryConfig(page(JSON.stringify({ dsn: "" })))).toBeUndefined();
  expect(readBrowserSentryConfig(page(JSON.stringify({ dsn: "https://public@sentry.test/1", environment: "staging", release: "c0ffee" })))).toEqual({
    dsn: "https://public@sentry.test/1", environment: "staging", release: "c0ffee",
  });
});

test("the page carries the DSN, environment and commit only when the server has a DSN", () => {
  expect(browserSentryConfig({})).toBeUndefined();
  expect(browserSentryConfig({ SENTRY_DSN: "https://public@sentry.test/1", RAILWAY_ENVIRONMENT_NAME: "production", TRAWLER_COMMIT: "c0ffee", BETTER_AUTH_SECRET: "a".repeat(40) })).toEqual({
    dsn: "https://public@sentry.test/1", environment: "production", release: "c0ffee",
  });
});
