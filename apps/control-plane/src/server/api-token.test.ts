import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ known: new Map<string, { tokenId: string; orgId: string; projectId: string | null }>(), asked: [] as string[], limited: false }));
vi.mock("./db.ts", () => ({ getDb: () => "the database" }));
vi.mock("../api-tokens/tokens.ts", () => ({
  authenticateToken: async (_db: unknown, token: string) => { state.asked.push(token); return state.known.get(token) ?? null; },
  withinTokenRate: () => (state.limited ? { ok: false, retryAfterSeconds: 12 } : { ok: true }),
}));

const { tokenWorkspace } = await import("./api-token.ts");
const TOKEN = `trw_${"a".repeat(43)}`;

beforeEach(() => {
  state.known = new Map([[TOKEN, { tokenId: "t1", orgId: "org-1", projectId: null }]]);
  state.asked = [];
  state.limited = false;
});

test("a call without a bearer token, or with a malformed header, is told how to send one, and the database is not asked", async () => {
  for (const authorization of [undefined, "", "Basic abc", "Bearer", `bearer ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
    const res = await tokenWorkspace(new Headers(authorization === undefined ? {} : { authorization }));
    expect(res.ok).toBe(false);
    if (res.ok) continue;
    expect(res.response.status).toBe(401);
    expect(res.response.headers.get("www-authenticate")).toBe("Bearer");
    expect(res.response.headers.get("cache-control")).toBe("no-store");
  }
  expect(state.asked).toEqual([]);
});

test("an unknown or revoked token is refused with 401, a good one gives its workspace", async () => {
  const bad = await tokenWorkspace(new Headers({ authorization: `Bearer trw_${"b".repeat(43)}` }));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.response.status).toBe(401);
  const good = await tokenWorkspace(new Headers({ authorization: `Bearer ${TOKEN}` }));
  expect(good).toEqual({ ok: true, holder: { tokenId: "t1", orgId: "org-1", projectId: null } });
});

test("a token over its rate gets 429 and when to try again", async () => {
  state.limited = true;
  const res = await tokenWorkspace(new Headers({ authorization: `Bearer ${TOKEN}` }));
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.response.status).toBe(429);
  expect(res.response.headers.get("retry-after")).toBe("12");
});
