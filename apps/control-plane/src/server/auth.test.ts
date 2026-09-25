import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

type Found = { user: { id: string; email: string }; session: { id: string; userId: string; activeOrganizationId: string | null } };
const state = vi.hoisted(() => ({ found: null as Found | null, workspace: null as string | null, checked: [] as unknown[] }));

vi.mock("./env.ts", () => ({ readEnv: () => ({ databaseUrl: "postgres://unused", authSecret: "x".repeat(32), baseURL: "http://localhost:3000" }) }));
vi.mock("../auth/auth.ts", () => ({
  authPool: () => ({}),
  createAuth: () => ({
    api: { getSession: async () => state.found },
    workspaceOf: async (session: unknown) => { state.checked.push(session); return state.workspace; },
  }),
}));

const { signedInMember } = await import("./auth.ts");
const found: Found = { user: { id: "u1", email: "ana@acme.test" }, session: { id: "s1", userId: "u1", activeOrganizationId: "org-1" } };

beforeEach(() => {
  state.found = null;
  state.workspace = null;
  state.checked = [];
});

test("a visitor who is not signed in is no member, and no workspace is looked up", async () => {
  expect(await signedInMember(new Headers())).toBeNull();
  expect(state.checked).toEqual([]);
});

test("a signed-in person is a member of the workspace the membership check returns, not the one the session names", async () => {
  state.found = found;
  state.workspace = "org-2";
  expect(await signedInMember(new Headers())).toEqual({ userId: "u1", email: "ana@acme.test", orgId: "org-2" });
  expect(state.checked).toEqual([found.session]);
});

test("a signed-in person the membership check finds in no workspace is no member", async () => {
  state.found = found;
  expect(await signedInMember(new Headers())).toBeNull();
});

test("only the membership check reads the workspace a session names", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const readers = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => readFileSync(`${src}/${file}`, "utf8").includes("activeOrganizationId"))
    .sort();
  expect(readers).toEqual(["auth/auth.ts", "db/types.ts"]);
});
