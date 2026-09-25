import { expect, test } from "vitest";
import { smokeCheck, type SmokeOptions } from "./smoke.ts";

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
  expect(calls.findIndex((c) => c.path === "/api/smoke/runs")).toBeGreaterThan(calls.findIndex((c) => c.path === "/sign-in"));
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
