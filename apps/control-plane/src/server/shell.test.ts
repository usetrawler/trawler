import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ tenants: [] as string[], navFor: [] as string[] }));

vi.mock("./db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../projects/overview.ts", () => ({
  workspaceNav: async (_tx: unknown, orgId: string) => { state.navFor.push(orgId); return { projects: [{ id: "p1", name: "Acme", address: "app.acme.test" }], runs: 4 }; },
}));

const { shellFor } = await import("./shell.ts");
const member = { userId: "u1", name: "Ana Lopez", email: "ana@acme.test", orgId: "org-1", orgName: "Acme Labs", role: "member" };

beforeEach(() => {
  state.tenants = [];
  state.navFor = [];
});

test("the shell names the person and the workspace the membership check found, with its projects and runs read in that workspace", async () => {
  expect(await shellFor(member)).toEqual({
    user: { name: "Ana Lopez", email: "ana@acme.test" },
    workspace: { name: "Acme Labs", projects: [{ id: "p1", name: "Acme", address: "app.acme.test" }], runs: 4 },
  });
  expect(state.tenants).toEqual(["org-1"]);
  expect(state.navFor).toEqual(["org-1"]);
});
