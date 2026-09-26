import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  member: null as null | { userId: string; name: string; email: string; orgId: string; orgName: string; role: string },
  key: null as null | { provider: string; hint: string; baseUrl: null; addedBy: string; addedAt: Date },
  members: {} as Record<string, string>,
  lookedUp: [] as Array<[string, string]>,
  tenants: [] as string[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  signedInMember: async () => state.member,
  canManageBilling: (member: { role: string }) => member.role === "owner" || member.role === "admin",
  getAuth: () => ({
    memberEmail: async (orgId: string, userId: string) => {
      state.lookedUp.push([orgId, userId]);
      return state.members[`${orgId}/${userId}`] ?? null;
    },
  }),
}));
vi.mock("../../server/shell.ts", () => ({
  shellFor: async (member: { name: string; email: string; orgName: string }) => ({ user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [], runs: 0 } }),
}));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../credentials/credentials.ts", () => ({ modelKeyDetails: async () => state.key }));
vi.mock("./actions.ts", () => ({ renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}) }));

const { default: SettingsPage } = await import("./page.tsx");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const owner = { userId: "user-1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" };
const addedAt = new Date("2026-09-25T18:50:00.000Z");

beforeEach(() => {
  Object.assign(state, { member: owner, key: null, members: { "org-1/user-2": "lee@acme.test" }, lookedUp: [], tenants: [] });
});

test("settings name who added the key among this workspace's members, and mark Settings in the panel as the page you are on", async () => {
  state.key = { provider: "openrouter", hint: "…a1b2", baseUrl: null, addedBy: "user-2", addedAt };
  const html = renderToStaticMarkup(await SettingsPage());
  expect(text(html)).toContain("Added by lee@acme.test on 2026-09-25 18:50 UTC");
  expect(state.lookedUp).toEqual([["org-1", "user-2"]]);
  expect(html).toMatch(/<a href="\/settings" aria-current="page"[^>]*>.*?Settings/);
  expect(html.match(/<input[^>]*\bname="name"[^>]*>/)?.[0]).toContain('value="Acme"');
  expect(state.tenants).toEqual(["org-1"]);
});

test("the page is headed like the app's other pages", async () => {
  expect(text(renderToStaticMarkup(await SettingsPage()))).toContain("Settings Workspace and model key. The name and the model key every run of this workspace uses.");
});

test("a key added by someone who is no longer in this workspace says so, and a workspace without a key looks nobody up", async () => {
  state.key = { provider: "openrouter", hint: "…a1b2", baseUrl: null, addedBy: "user-gone", addedAt };
  expect(text(renderToStaticMarkup(await SettingsPage()))).toContain("Added by someone no longer in this workspace on");
  state.key = null;
  state.lookedUp = [];
  renderToStaticMarkup(await SettingsPage());
  expect(state.lookedUp).toEqual([]);
});

test("a member gets the name and the key to read, with who can change them", async () => {
  state.member = { ...owner, role: "member" };
  state.key = { provider: "openrouter", hint: "…a1b2", baseUrl: null, addedBy: "user-2", addedAt };
  const html = renderToStaticMarkup(await SettingsPage());
  expect(text(html)).toContain("Only an owner or admin of this workspace can rename it.");
  expect(text(html)).toContain("Only an owner or admin of this workspace can change the key.");
  expect(html).not.toContain("<form");
});

test("someone signed out, or no longer in the workspace, is sent to sign in", async () => {
  state.member = null;
  await expect(SettingsPage()).rejects.toMatchObject({ to: "/sign-in" });
});
