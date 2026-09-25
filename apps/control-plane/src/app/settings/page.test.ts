import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  signedIn: true,
  manager: true,
  key: null as null | { provider: string; hint: string; baseUrl: null; addedBy: string; addedAt: Date },
  tenants: [] as string[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  getAuth: () => ({ api: {
    getSession: async () => (state.signedIn ? { user: { id: "user-1", email: "ana@acme.test" }, session: { activeOrganizationId: "org-1" } } : null),
    getFullOrganization: async () => ({ name: "Acme", members: [{ userId: "user-1", user: { email: "ana@acme.test" } }, { userId: "user-2", user: { email: "lee@acme.test" } }] }),
  } }),
  canManageBilling: async () => state.manager,
}));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => { state.tenants.push(orgId); return work({}); } }));
vi.mock("../../credentials/credentials.ts", () => ({ modelKeyDetails: async () => state.key }));
vi.mock("./actions.ts", () => ({ renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}) }));

const { default: SettingsPage } = await import("./page.tsx");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  Object.assign(state, { signedIn: true, manager: true, key: null, tenants: [] });
});

test("settings name who added the key from the workspace's members, and mark Settings as the page you are on", async () => {
  state.key = { provider: "openrouter", hint: "…a1b2", baseUrl: null, addedBy: "user-2", addedAt: new Date("2026-09-25T18:50:00.000Z") };
  const html = renderToStaticMarkup(await SettingsPage());
  expect(text(html)).toContain("Added by lee@acme.test on 2026-09-25 18:50 UTC");
  expect(html).toMatch(/<a href="\/settings" aria-current="page"[^>]*>Settings<\/a>/);
  expect(html.match(/<input[^>]*\bname="name"[^>]*>/)?.[0]).toContain('value="Acme"');
  expect(state.tenants).toEqual(["org-1"]);
});

test("a key added by someone who is no longer a member says so", async () => {
  state.key = { provider: "openrouter", hint: "…a1b2", baseUrl: null, addedBy: "user-gone", addedAt: new Date("2026-09-25T18:50:00.000Z") };
  expect(text(renderToStaticMarkup(await SettingsPage()))).toContain("Added by someone no longer in this workspace on");
});

test("a member gets both sections read-only", async () => {
  state.manager = false;
  const html = text(renderToStaticMarkup(await SettingsPage()));
  expect(html).toContain("Only an owner or admin of this workspace can rename it.");
  expect(html).toContain("Only an owner or admin of this workspace can change the key.");
});

test("someone who is not signed in is sent to sign in", async () => {
  state.signedIn = false;
  await expect(SettingsPage()).rejects.toMatchObject({ to: "/sign-in" });
});
