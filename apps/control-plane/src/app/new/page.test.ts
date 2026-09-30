import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; name: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as { userId: string; name: string; email: string; orgId: string; orgName: string; role: string } | null, shells: [] as string[], limit: null as null | { plan: "free" | "team" | "enterprise"; limits: { projects: number; runsPerDay: number; people: number } } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null),
}));
vi.mock("../../server/shell.ts", () => ({
  shellFor: async (member: Member) => {
    state.shells.push(member.orgId);
    return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [], runs: 0 } };
  },
}));
vi.mock("../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _org: string, work: (tx: unknown) => Promise<unknown>) => work({}) }));
vi.mock("../../runs/plans.ts", () => ({ projectLimitReached: async () => state.limit }));
vi.mock("./setup-wizard.tsx", () => ({ SetupWizard: ({ intro }: { intro: unknown }) => intro }));

const { default: NewProjectPage } = await import("./page.tsx");

beforeEach(() => {
  state.member = { userId: "u1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };
  state.shells = [];
  state.limit = null;
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in", async () => {
  state.member = null;
  await expect(NewProjectPage()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.shells).toEqual([]);
});

test("the new project page is marked as the one the person is on, with the nav of the signed-in workspace", async () => {
  const html = renderToStaticMarkup(await NewProjectPage());
  expect(html).toContain(">Acme workspace</p>");
  expect(html).toMatch(/<a href="\/new" aria-current="page"[^>]*>(?:(?!<\/a>).)*New project<\/span><\/span><\/a>/);
  expect(state.shells).toEqual(["org-1"]);
  expect(html).toMatch(/<main[^>]*>.*>New project<\/p><h1[^>]*>What should Trawler use\?<\/h1>/);
  expect(html).not.toContain('aria-label="Progress"');
});

test("Sign out sits in the header on a phone and under the nav on wider screens, once each", async () => {
  const html = renderToStaticMarkup(await NewProjectPage());
  const header = html.match(/<header.*<\/header>/)?.[0] ?? "";
  expect(header.match(/>Sign out</g)).toHaveLength(1);
  expect(header).toMatch(/class="[^"]*\bmd:hidden\b[^"]*">Sign out</);
  const panel = html.slice(html.indexOf("</nav>"), html.indexOf("<main"));
  expect(panel.match(/>Sign out</g)).toHaveLength(1);
  expect(html.match(/>Sign out</g)).toHaveLength(2);
});

test("a workspace at its plan's project limit is told so, with what to do, instead of the setup", async () => {
  state.limit = { plan: "free", limits: { projects: 1, runsPerDay: 3, people: 4 } };
  const html = renderToStaticMarkup(await NewProjectPage());
  expect(html).toContain(">This workspace has all its projects.</h1>");
  expect(html).toContain("The Free plan includes 1 project, and this workspace has 1 project already.");
  expect(html).toContain('<a href="/"');
  expect(html).not.toContain("What should Trawler use?");
});
