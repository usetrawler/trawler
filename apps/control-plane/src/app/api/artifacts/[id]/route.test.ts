import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as Member | null, store: "the store" as string | undefined, file: null as { body: ReadableStream<Uint8Array>; contentType: string; size: number } | null, asked: [] as unknown[][], logged: [] as unknown[][], fails: false }));
vi.mock("../../../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../../../../server/log.ts", () => ({ logError: async (...args: unknown[]) => void state.logged.push(args) }));
vi.mock("../../../../server/db.ts", () => ({ getDb: () => "the database" }));
vi.mock("../../../../server/artifacts.ts", () => ({ artifactStore: () => state.store }));
vi.mock("../../../../artifacts/artifacts.ts", () => ({
  openArtifact: async (...args: unknown[]) => {
    state.asked.push(args);
    if (state.fails) throw new Error("the bucket did not answer");
    return state.file;
  },
}));

const { GET } = await import("./route.ts");
const ID = "5c47ee07-f625-4cf1-8e26-a6543ebb4a5f";
const open = (id: string, cookie = "session=ana") =>
  GET(new Request(`http://cp.test/api/artifacts/${id}`, { headers: { cookie } }) as never, { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-2", orgName: "Acme", role: "member" };
  state.store = "the store";
  state.file = null;
  state.asked = [];
  state.logged = [];
  state.fails = false;
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

test("the file is looked up in the workspace the membership check returns and streamed with its own type and size, never cached, with no bucket address in the answer", async () => {
  state.file = { body: new Response(new Uint8Array([1, 2, 3])).body!, contentType: "image/png", size: 3 };
  const res = await open(ID);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-length")).toBe("3");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(state.asked).toEqual([["the database", "the store", "org-2", ID]]);
});

test("a bucket that fails answers 502, never cached, and the failure is logged with the workspace and file", async () => {
  state.fails = true;
  const res = await open(ID);
  expect(res.status).toBe(502);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(state.logged).toEqual([["a screen capture could not be read from the bucket", { orgId: "org-2", artifactId: ID, err: expect.any(Error) }]]);
});
