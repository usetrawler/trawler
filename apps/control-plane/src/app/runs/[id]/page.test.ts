import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; name: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ access: { signedIn: false } as unknown, asked: [] as Array<[string | null, string]>, shells: [] as unknown[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../server/runs.ts", () => ({ runFor: async (headers: Headers, id: string) => { state.asked.push([headers.get("cookie"), id]); return state.access; } }));
vi.mock("../../../server/shell.ts", () => ({
  shellFor: async (member: Member) => {
    state.shells.push(member);
    return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [{ id: "p1", name: "Acme", address: "app.acme.test" }], runs: 4 } };
  },
}));
vi.mock("../../../runs/report.ts", () => ({ runView: () => ({}) }));
vi.mock("./run-live.tsx", () => ({ RunLive: () => null }));

const { default: RunPage } = await import("./page.tsx");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const open = () => RunPage({ params: Promise.resolve({ id: ID }) });
const member: Member = { userId: "u1", name: "Ana Lopez", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };

beforeEach(() => {
  state.access = { signedIn: false };
  state.asked = [];
  state.shells = [];
});

test("a visitor who is not signed in, or no longer belongs to the workspace, is sent to sign in", async () => {
  await expect(open()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.asked).toEqual([["session=ana", ID]]);
  expect(state.shells).toEqual([]);
});

test("a run that is not in the member's workspace is not found", async () => {
  state.access = { signedIn: true, member, run: null };
  await expect(open()).rejects.toMatchObject({ notFound: true });
  expect(state.shells).toEqual([]);
});

test("a run's page marks its project in the nav as the section it belongs to, inside its workspace's shell", async () => {
  state.access = { signedIn: true, member, run: { id: ID, projectId: "p1", number: 17 } };
  const html = renderToStaticMarkup(await open());
  const marked = html.match(/<a [^>]*aria-current="[^"]*"[^>]*>/g) ?? [];
  expect(marked).toEqual([expect.stringMatching(/^<a href="\/projects\/p1" aria-current="true"/)]);
  expect(state.shells).toEqual([member]);
  expect(html).toContain(">Acme workspace</p>");
  expect(html).toContain(">Ana Lopez</p>");
});

test("a run's page leads back to its project and the project's runs, without the setup steps", async () => {
  state.access = { signedIn: true, member, run: { id: ID, projectId: "p1", number: 17 } };
  const html = renderToStaticMarkup(await open());
  const crumbs = html.match(/<nav aria-label="Breadcrumb".*?<\/nav>/)?.[0] ?? "";
  expect(crumbs).toMatch(/<a href="\/projects\/p1"[^>]*>Acme<\/a>.*<a href="\/projects\/p1\/runs"[^>]*>Runs<\/a>.*<li aria-current="page"[^>]*>Run 0017<\/li>/);
  expect(html).not.toContain('aria-label="Progress"');
});

test("a run's page takes the shell's full width, as the mockup's report does", async () => {
  state.access = { signedIn: true, member, run: { id: ID, projectId: "p1", number: 17 } };
  const html = renderToStaticMarkup(await open());
  expect(html).toMatch(/<div class="w-full"><nav aria-label="Breadcrumb"/);
});
