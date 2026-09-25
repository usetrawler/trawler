import { beforeEach, expect, test, vi } from "vitest";

type Session = { session: { activeOrganizationId: string | null } };
const state = vi.hoisted(() => ({ session: null as Session | null, store: "the store" as string | undefined, link: null as string | null, asked: [] as unknown[][] }));
vi.mock("../../../../server/auth.ts", () => ({ getAuth: () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("../../../../server/db.ts", () => ({ getDb: () => "the database" }));
vi.mock("../../../../server/artifacts.ts", () => ({ artifactStore: () => state.store }));
vi.mock("../../../../artifacts/artifacts.ts", () => ({
  artifactLink: async (...args: unknown[]) => {
    state.asked.push(args);
    return state.link;
  },
}));

const { GET } = await import("./route.ts");
const open = (id: string) => GET(new Request(`http://cp.test/api/artifacts/${id}`) as never, { params: Promise.resolve({ id }) });
const ID = "5c47ee07-f625-4cf1-8e26-a6543ebb4a5f";

beforeEach(() => {
  state.session = { session: { activeOrganizationId: "org-1" } };
  state.store = "the store";
  state.link = null;
  state.asked = [];
});

test("someone signed out is told to sign in, and the answer is never cached", async () => {
  state.session = null;
  const res = await open(ID);
  expect(res.status).toBe(401);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(state.asked).toEqual([]);
});

test("an account without a workspace, a server without storage, or a file the workspace does not have gets 404", async () => {
  state.session = { session: { activeOrganizationId: null } };
  expect((await open(ID)).status).toBe(404);
  state.session = { session: { activeOrganizationId: "org-1" } };
  state.store = undefined;
  expect((await open(ID)).status).toBe(404);
  expect(state.asked).toEqual([]);
  state.store = "the store";
  const res = await open(ID);
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(state.asked).toEqual([["the database", "the store", "org-1", ID]]);
});

test("the workspace's own file redirects to its short-lived link, never cached", async () => {
  state.link = "https://bucket.test/orgs/org-1/runs/r/a.png?X-Amz-Expires=300";
  const res = await open(ID);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(state.link);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
});
