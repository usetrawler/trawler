import { afterEach, expect, test, vi } from "vitest";
import { smokeCheck, smokeToken, type SmokeOptions } from "./smoke.ts";

const BASE = "https://staging.test";
const COMMIT = "c0ffee";
const TOKEN = "smoke-" + "s".repeat(40);

type Reply = { status: number; body?: unknown } | Error;

function fakeServer(routes: Record<string, Reply[]>) {
  const calls: Array<{ method: string; path: string; auth: string | null }> = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, auth: new Headers(init?.headers).get("authorization") });
    const key = `${method} ${path}`;
    const queue = routes[key] ?? routes[`${method} ${path.replace(/[0-9a-f-]{36}$/, ":id")}`];
    if (!queue?.length) throw new Error(`unexpected ${key}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  let clock = 0;
  const opts: SmokeOptions = { base: BASE, commit: COMMIT, token: TOKEN, fetch: fakeFetch, sleep: async (ms) => void (clock += ms), now: () => clock, log: () => {}, pollMs: 1000, deployTimeoutMs: 10_000, runTimeoutMs: 20_000 };
  return { calls, opts };
}

const RUN = "11111111-1111-4111-8111-111111111111";
const result = (over: Record<string, unknown> = {}) => ({
  runId: RUN, status: "succeeded", finished: true, costUsd: 0.01, goalsReached: 1, goalsTotal: 1,
  jobs: [{ kind: "role_session", status: "succeeded", stoppedBy: "finish", error: null }], ...over,
});

test("waits for staging to run the commit, checks sign-in, and passes a finished run", async () => {
  const { calls, opts } = fakeServer({
    "GET /healthz": [new Error("connection refused"), { status: 200, body: { ok: true, commit: "0ld" } }, { status: 200, body: { ok: true, commit: COMMIT } }],
    "GET /sign-in": [{ status: 200 }],
    "POST /api/smoke/runs": [{ status: 201, body: { runId: RUN } }],
    "GET /api/smoke/runs/:id": [{ status: 200, body: result({ status: "running", finished: false }) }, { status: 503 }, { status: 200, body: result() }],
  });
  expect(await smokeCheck(opts)).toMatchObject({ runId: RUN, status: "succeeded" });
  expect(calls.filter((c) => c.path === "/healthz")).toHaveLength(3);
  expect(calls.filter((c) => c.path.startsWith("/api/smoke")).every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  const signIn = calls.findIndex((c) => c.path === "/sign-in");
  expect(signIn).toBeGreaterThanOrEqual(0);
  expect(calls.findIndex((c) => c.path === "/api/smoke/runs")).toBeGreaterThan(signIn);
});

test("fails when staging never runs the commit, without starting a run", async () => {
  const { calls, opts } = fakeServer({ "GET /healthz": [{ status: 200, body: { ok: true, commit: "0ld" } }] });
  await expect(smokeCheck(opts)).rejects.toThrow(/did not start c0ffee.*0ld/);
  expect(calls.some((c) => c.path.startsWith("/api/smoke"))).toBe(false);
});

test("fails when the sign-in page is broken", async () => {
  const { opts } = fakeServer({ "GET /healthz": [{ status: 200, body: { ok: true, commit: COMMIT } }], "GET /sign-in": [{ status: 500 }] });
  await expect(smokeCheck(opts)).rejects.toThrow(/sign-in page answered HTTP 500/);
});

test("fails when the run cannot start", async () => {
  const { opts } = fakeServer({
    "GET /healthz": [{ status: 200, body: { ok: true, commit: COMMIT } }], "GET /sign-in": [{ status: 200 }],
    "POST /api/smoke/runs": [{ status: 503, body: { error: "the smoke check needs OPENROUTER_API_KEY on this server" } }],
  });
  await expect(smokeCheck(opts)).rejects.toThrow(/could not start.*503.*OPENROUTER_API_KEY/);
});

test("fails a run that did not succeed and names every job that went wrong", async () => {
  const { opts } = fakeServer({
    "GET /healthz": [{ status: 200, body: { ok: true, commit: COMMIT } }], "GET /sign-in": [{ status: 200 }],
    "POST /api/smoke/runs": [{ status: 201, body: { runId: RUN } }],
    "GET /api/smoke/runs/:id": [{ status: 200, body: result({ status: "failed", goalsReached: 0, jobs: [{ kind: "role_session", status: "failed", stoppedBy: "error", error: "the browser failed 3 times in a row" }] }) }],
  });
  await expect(smokeCheck(opts)).rejects.toThrow(/ended as failed[\s\S]*role_session failed \(error\): the browser failed 3 times in a row[\s\S]*no goal was reached/);
});

test("fails a run that succeeded without reaching its goal", async () => {
  const { opts } = fakeServer({
    "GET /healthz": [{ status: 200, body: { ok: true, commit: COMMIT } }], "GET /sign-in": [{ status: 200 }],
    "POST /api/smoke/runs": [{ status: 201, body: { runId: RUN } }],
    "GET /api/smoke/runs/:id": [{ status: 200, body: result({ goalsReached: 0 }) }],
  });
  await expect(smokeCheck(opts)).rejects.toThrow(/no goal was reached/);
});

test("fails a run that does not finish in time", async () => {
  const { opts } = fakeServer({
    "GET /healthz": [{ status: 200, body: { ok: true, commit: COMMIT } }], "GET /sign-in": [{ status: 200 }],
    "POST /api/smoke/runs": [{ status: 201, body: { runId: RUN } }],
    "GET /api/smoke/runs/:id": [{ status: 200, body: result({ status: "running", finished: false }) }],
  });
  await expect(smokeCheck(opts)).rejects.toThrow(/did not finish in time.*running/);
});

function fakeControlPlaneVariables(token: string | undefined) {
  let calls = 0;
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    calls++;
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const data = query.includes("projectToken") ? { projectToken: { projectId: "p", environmentId: "e", environment: { name: "staging" } } }
      : query.includes("services") ? { project: { services: { edges: [{ node: { id: "s-cp", name: "control-plane" } }] } } }
      : { variables: token === undefined ? {} : { TRAWLER_SMOKE_TOKEN: token } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls: () => calls };
}

afterEach(() => vi.restoreAllMocks());

test("a smoke token given directly is trimmed and used without asking Railway, unless it is blank", async () => {
  const railway = fakeControlPlaneVariables(TOKEN);
  expect(await smokeToken({ TRAWLER_SMOKE_TOKEN: ` given-${"g".repeat(40)}\n`, RAILWAY_CORE_TOKEN: "core" }, railway.fetch, () => {})).toBe("given-" + "g".repeat(40));
  expect(railway.calls()).toBe(0);
  expect(await smokeToken({ TRAWLER_SMOKE_TOKEN: "  ", RAILWAY_CORE_TOKEN: "core" }, railway.fetch, () => {})).toBe(TOKEN);
});

test("the smoke token read from the control plane is trimmed like the server trims it, masked in GitHub Actions and never printed elsewhere", async () => {
  const console = [
    ...(["log", "error", "warn", "info", "debug"] as const).map((level) => vi.spyOn(globalThis.console, level)),
    vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write"),
  ];
  const printed: string[] = [];
  expect(await smokeToken({ RAILWAY_CORE_TOKEN: "core", GITHUB_ACTIONS: "true" }, fakeControlPlaneVariables(` ${TOKEN}\n`).fetch, (line) => printed.push(line))).toBe(TOKEN);
  expect(printed).toEqual([`::add-mask::${TOKEN}`]);
  printed.length = 0;
  expect(await smokeToken({ RAILWAY_CORE_TOKEN: "core" }, fakeControlPlaneVariables(TOKEN).fetch, (line) => printed.push(line))).toBe(TOKEN);
  expect(printed).toEqual([]);
  expect(console.flatMap((spy) => spy.mock.calls.flat()).some((arg) => String(arg).includes(TOKEN))).toBe(false);
});

test("without a way to get the smoke token the check says what to set", async () => {
  await expect(smokeToken({}, fakeControlPlaneVariables(TOKEN).fetch, () => {})).rejects.toThrow(/set TRAWLER_SMOKE_TOKEN, or RAILWAY_CORE_TOKEN/);
  await expect(smokeToken({ RAILWAY_CORE_TOKEN: "core" }, fakeControlPlaneVariables(undefined).fetch, () => {})).rejects.toThrow("the control plane behind RAILWAY_CORE_TOKEN has no TRAWLER_SMOKE_TOKEN Railway will show; a sealed variable is never shown, so pass TRAWLER_SMOKE_TOKEN to the job instead");
});
