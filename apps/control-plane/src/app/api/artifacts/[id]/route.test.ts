import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, store: "the store" as string | undefined, link: null as string | null, asked: [] as unknown[][] }));
vi.mock("../../../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../../../../server/db.ts", () => ({ getDb: () => "the database" }));
vi.mock("../../../../server/artifacts.ts", () => ({ artifactStore: () => state.store }));
vi.mock("../../../../artifacts/artifacts.ts", () => ({
  artifactLink: async (...args: unknown[]) => {
    state.asked.push(args);
    return state.link;
  },
}));

const { GET } = await import("./route.ts");
const ID = "5c47ee07-f625-4cf1-8e26-a6543ebb4a5f";
const open = (id: string, cookie = "session=ana") =>
  GET(new Request(`http://cp.test/api/artifacts/${id}`, { headers: { cookie } }) as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme", role: "member" };
  state.store = "the store";
  state.link = null;
  state.asked = [];
});

test("someone signed out, or no longer a member of their session's workspace, is told to sign in, and the answer is never cached", async () => {
  state.member = null;
  const removed = await open(ID);
  expect(removed.status).toBe(401);
  expect(removed.headers.get("cache-control")).toBe("no-store");
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme", role: "member" };
  expect((await open(ID, "")).status).toBe(401);
  expect(state.asked).toEqual([]);
});

test("a server without storage, or a file the workspace does not have, gets 404, never cached", async () => {
  state.store = undefined;
  expect((await open(ID)).status).toBe(404);
  expect(state.asked).toEqual([]);
  state.store = "the store";
  const res = await open(ID);
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("the file is looked up in the workspace the membership check returns, and redirects to its short-lived link, never cached", async () => {
  state.link = "https://bucket.test/orgs/org-2/runs/r/a.png?X-Amz-Expires=300";
  const res = await open(ID);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(state.link);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(state.asked).toEqual([["the database", "the store", "org-2", ID]]);
});
