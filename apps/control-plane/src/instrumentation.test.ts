import * as Sentry from "@sentry/nextjs";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { onRequestError } from "./instrumentation.ts";
import { browserSentryOptions, DATA_COLLECTION, readBrowserSentryConfig, SENTRY_META } from "./lib/browser-sentry.ts";
import { browserSentryConfig, sentryMeta, serverSentryOptions } from "./server/sentry.ts";

const TOKEN = "r".repeat(40);
let lines: string[];
const sent: string[] = [];

beforeAll(() => {
  Sentry.init({
    ...serverSentryOptions({ SENTRY_DSN: "https://public@sentry.test/1", TRAWLER_RUNNER_TOKEN: TOKEN })!,
    transport: () => ({
      send: async (envelope: unknown) => {
        if (JSON.stringify(envelope).includes('"type":"event"')) sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
});

afterAll(() => Sentry.close());

beforeEach(() => {
  lines = [];
  sent.length = 0;
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("an error while serving a request is logged and reported with Railway's request id, and without the query string", async () => {
  vi.stubEnv("TRAWLER_RUNNER_TOKEN", TOKEN);
  const code = ["oauth", "code", "from", "github"].join("-");
  const failure = Object.assign(new Error(`render failed near ${TOKEN}`), { digest: "2717893" });
  await onRequestError(
    failure,
    { path: `/api/auth/callback/github?code=${code}&state=st4te`, method: "GET", headers: { "x-railway-request-id": "rr-42" } },
    { routerKind: "App Router", routePath: "/api/auth/[...all]", routeType: "route", renderSource: "react-server-components", revalidateReason: undefined },
  );
  const record = JSON.parse(lines.at(-1)!);
  expect(record).toMatchObject({ level: "error", msg: "request failed", path: "/api/auth/callback/github", method: "GET", route: "/api/auth/[...all]", route_type: "route", request_id: "rr-42", digest: "2717893" });
  expect(record.error.message).toBe("render failed near •••");
  await Sentry.flush(1000);
  expect(sent).toHaveLength(1);
  const event = JSON.parse(sent[0]!)[1][0][1];
  expect(event.tags).toMatchObject({ request_id: "rr-42" });
  expect(event.exception.values[0].value).toBe("render failed near •••");
  expect(sent[0]).not.toContain(code);
  expect(lines.join("\n")).not.toContain(code);
});

const page = (meta: Record<string, string> | undefined) => ({
  querySelector: (selector: string) =>
    meta && selector === `meta[name="${SENTRY_META}"]` ? { getAttribute: (name: string) => (name === "content" ? meta[SENTRY_META] ?? null : null) } : null,
});

test("the browser reads the DSN, environment and commit the layout renders, and starts nothing without them", () => {
  const env = { SENTRY_DSN: "https://public@sentry.test/1", RAILWAY_ENVIRONMENT_NAME: "production", TRAWLER_COMMIT: "c0ffee", BETTER_AUTH_SECRET: "a".repeat(40) };
  expect(sentryMeta({})).toBeUndefined();
  expect(readBrowserSentryConfig(page(sentryMeta(env)))).toEqual({ dsn: "https://public@sentry.test/1", environment: "production", release: "c0ffee" });
  expect(browserSentryConfig(env)).toEqual({ dsn: "https://public@sentry.test/1", environment: "production", release: "c0ffee" });
  expect(readBrowserSentryConfig(page(undefined))).toBeUndefined();
  expect(readBrowserSentryConfig(page({ [SENTRY_META]: "not json" }))).toBeUndefined();
  expect(readBrowserSentryConfig(page({ [SENTRY_META]: JSON.stringify({ dsn: "" }) }))).toBeUndefined();
});

test("the browser sends errors only, without sessions, trace headers, or query strings in URLs", () => {
  const options = browserSentryOptions({ dsn: "https://public@sentry.test/1", environment: "production", release: "c0ffee" });
  expect(options).toMatchObject({ dsn: "https://public@sentry.test/1", environment: "production", release: "c0ffee", tracePropagationTargets: [] });
  expect(options.dataCollection).toBe(DATA_COLLECTION);
  const pick = options.integrations as (defaults: Array<{ name: string }>) => Array<{ name: string }>;
  expect(pick([{ name: "BrowserSession" }, { name: "GlobalHandlers" }]).map((i) => i.name)).toEqual(["GlobalHandlers"]);
  expect(options.beforeSend!({ type: undefined, request: { url: "https://app.usetrawler.com/sign-in?error=state_mismatch#top" } }, {})).toMatchObject({ request: { url: "https://app.usetrawler.com/sign-in" } });
  expect(options.beforeBreadcrumb!({ category: "navigation", data: { from: "/sign-in?code=abc", to: "/new?x=1" } }, {})).toMatchObject({ data: { from: "/sign-in", to: "/new" } });
  expect(options.beforeBreadcrumb!({ category: "fetch", data: { url: "/api/runs/1?token=abc", method: "GET" } }, {})).toMatchObject({ data: { url: "/api/runs/1", method: "GET" } });
});
