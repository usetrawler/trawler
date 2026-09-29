import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  member: null as null | { userId: string; name: string; email: string; orgId: string; orgName: string; role: string },
  key: null as null | { provider: string; hint: string; baseUrl: null; addedBy: string; addedAt: Date },
  members: {} as Record<string, string>,
  lookedUp: [] as Array<[string, string]>,
  tenants: [] as string[],
  listed: [] as string[],
  people: [] as Array<{ id: string; userId: string; role: string; joinedAt: Date; name: string; email: string }>,
  invited: [] as Array<{ id: string; email: string; role: string; expiresAt: Date; addressHasWorkspace: boolean }>,
  actionResult: null as null | Record<string, unknown>,
  budget: null as null | { limitUsd: number; spentUsd: number },
  spent: 0,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (_action: unknown, initial: unknown) => [state.actionResult ?? initial, () => {}, false],
  useReducer: (_reducer: unknown, initial: Record<string, unknown>) => [state.actionResult && "sent" in initial ? { ...initial, sent: { change: "invite", before: {} } } : initial, () => {}],
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
    workspaceMembers: async (orgId: string) => { state.listed.push(`members:${orgId}`); return state.people; },
    pendingInvitations: async (orgId: string) => { state.listed.push(`invitations:${orgId}`); return state.invited; },
  }),
}));
vi.mock("../../server/shell.ts", () => ({
  shellFor: async (member: { name: string; email: string; orgName: string }) => ({ user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [], runs: 0 } }),
}));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../server/env.ts", () => ({ readEnv: () => ({ baseURL: "https://app.usetrawler.test" }) }));
vi.mock("../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../credentials/credentials.ts", () => ({ modelKeyDetails: async () => state.key }));
vi.mock("../../runs/limits.ts", () => ({ monthlyBudget: async () => state.budget, monthSpent: async () => state.spent }));
vi.mock("./actions.ts", () => ({
  setMonthlyBudgetAction: async () => ({}), removeMonthlyBudgetAction: async () => ({}),
  renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}),
  inviteMemberAction: async () => ({}), revokeInvitationAction: async () => ({}), removeMemberAction: async () => ({}), changeRoleAction: async () => ({}),
}));

const { default: SettingsPage } = await import("./page.tsx");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const owner = { userId: "user-1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" };
const addedAt = new Date("2026-09-25T18:50:00.000Z");

beforeEach(() => {
  Object.assign(state, {
    member: owner, key: null, members: { "org-1/user-2": "lee@acme.test" }, lookedUp: [], tenants: [], listed: [], actionResult: null, budget: null, spent: 0,
    people: [
      { id: "m-1", userId: "user-1", role: "owner", joinedAt: new Date("2026-09-20T10:00:00Z"), name: "Ana", email: "ana@acme.test" },
      { id: "m-2", userId: "user-2", role: "member", joinedAt: new Date("2026-09-21T10:00:00Z"), name: "Lee", email: "lee@acme.test" },
    ],
    invited: [{ id: "inv-1", email: "max@acme.test", role: "admin", expiresAt: new Date("2026-10-03T10:00:00Z"), addressHasWorkspace: false }],
  });
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
  expect(text(renderToStaticMarkup(await SettingsPage()))).toContain("Settings Workspace, members, model key and budget. The name, the people in it, the model key every run of this workspace uses, and what runs may spend in a month.");
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

test("the members of this workspace and its invitations are listed, marking you, and invitations tell where to sign in", async () => {
  const html = renderToStaticMarkup(await SettingsPage());
  expect(state.listed.sort()).toEqual(["invitations:org-1", "members:org-1"]);
  expect(text(html)).toContain("Ana (you) ana@acme.test Owner Joined 2026-09-20 10:00 UTC");
  expect(text(html)).toContain("Lee lee@acme.test Member Joined 2026-09-21 10:00 UTC");
  expect(text(html)).toContain("Invited max@acme.test Admin Expires 2026-10-03 10:00 UTC");
  expect(text(html)).not.toContain("can no longer use this invitation");
  state.invited = [{ ...state.invited[0]!, addressHasWorkspace: true }];
  expect(text(renderToStaticMarkup(await SettingsPage()))).toContain("max@acme.test Admin This address has since signed in and belongs to a workspace, so it can no longer use this invitation.");
  expect(html.indexOf('id="workspace-heading"')).toBeLessThan(html.indexOf('id="members-heading"'));
  expect(html.indexOf('id="members-heading"')).toBeLessThan(html.indexOf('id="key-heading"'));
  state.actionResult = { invited: "new@acme.test" };
  expect(text(renderToStaticMarkup(await SettingsPage()))).toContain("Invited new@acme.test. Ask them to sign in at app.usetrawler.test with this address; no email is sent.");
});

test("the monthly budget shows this month's spend to everyone, and only an owner or admin can change it", async () => {
  state.budget = { limitUsd: 50, spentUsd: 12.4 };
  state.spent = 12.4;
  const month = new Date().toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  const ownerView = text(renderToStaticMarkup(await SettingsPage()));
  expect(ownerView).toContain(`Monthly budget Spent on runs since ${month} 1 (UTC): $12.40 of $50.00`);
  expect(ownerView).toContain("Save budget");
  expect(ownerView).toContain("Remove budget");
  expect(renderToStaticMarkup(await SettingsPage()).match(/<input[^>]*name="monthly"[^>]*>/)?.[0]).toMatch(/type="number"[^>]*value="50.00"/);
  state.member = { ...owner, role: "member" };
  const memberView = text(renderToStaticMarkup(await SettingsPage()));
  expect(memberView).toContain("$12.40 of $50.00");
  expect(memberView).toContain("Only an owner or admin of this workspace can change the budget.");
  expect(memberView).not.toContain("Save budget");
  state.budget = null;
  expect(text(renderToStaticMarkup(await SettingsPage()))).toContain("No budget is set, so only each run's own cap limits what runs spend.".replace("'", "&#x27;"));
});
