import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

type Found = { user: { id: string; email: string }; session: { id: string; userId: string; activeOrganizationId: string | null } };
type Workspace = { orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ found: null as Found | null, workspace: null as Workspace | null, checked: [] as unknown[], asked: [] as Headers[] }));

vi.mock("./env.ts", () => ({ readEnv: () => ({ databaseUrl: "postgres://unused", authSecret: "x".repeat(32), baseURL: "http://localhost:3000" }) }));
vi.mock("../auth/auth.ts", () => ({
  authPool: () => ({}),
  createAuth: () => ({
    api: { getSession: async ({ headers }: { headers: Headers }) => { state.asked.push(headers); return state.found; } },
    workspaceOf: async (session: unknown) => { state.checked.push(session); return state.workspace; },
  }),
}));

const { canManageBilling, signedInMember } = await import("./auth.ts");
const found: Found = { user: { id: "u1", email: "ana@acme.test" }, session: { id: "s1", userId: "u1", activeOrganizationId: "org-1" } };

beforeEach(() => {
  state.found = null;
  state.workspace = null;
  state.checked = [];
  state.asked = [];
});

test("a visitor who is not signed in is no member, and no workspace is looked up", async () => {
  expect(await signedInMember(new Headers())).toBeNull();
  expect(state.checked).toEqual([]);
});

test("a signed-in person is a member of the workspace the membership check returns, for the request they made", async () => {
  state.found = found;
  state.workspace = { orgId: "org-1", orgName: "Acme", role: "owner" };
  const request = new Headers({ cookie: "session=ana" });
  expect(await signedInMember(request)).toEqual({ userId: "u1", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" });
  expect(state.asked).toEqual([request]);
  expect(state.checked).toEqual([found.session]);
});

test("a plain member stays a plain member, and does not manage the model key", async () => {
  state.found = found;
  state.workspace = { orgId: "org-1", orgName: "Acme", role: "member" };
  const member = await signedInMember(new Headers());
  expect(member).toEqual({ userId: "u1", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "member" });
  expect(canManageBilling(member!)).toBe(false);
});

test("a signed-in person the membership check finds in no workspace is no member", async () => {
  state.found = found;
  expect(await signedInMember(new Headers())).toBeNull();
});

test("owners and admins manage the model key, by the role the membership check found", () => {
  const as = (role: string) => canManageBilling({ userId: "u1", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role });
  expect([as("owner"), as("admin"), as("member, admin"), as("member"), as("")]).toEqual([true, true, true, false, false]);
});

test("only the membership check reads the workspace a session names", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const sources = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
  const reading = (text: string) => sources.filter((file) => readFileSync(`${src}/${file}`, "utf8").includes(text)).sort();
  expect(reading("activeOrganizationId")).toEqual(["auth/auth.ts", "db/types.ts"]);
  expect(reading("getActiveMember")).toEqual([]);
  expect(reading("getFullOrganization")).toEqual([]);
});
