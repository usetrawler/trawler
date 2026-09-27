import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Member = { userId: string; name: string; email: string; orgId: string; orgName: string; role: string };
const state = vi.hoisted(() => ({ member: null as unknown, capture: null as unknown, asked: [] as unknown[][], shells: [] as unknown[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../server/auth.ts", () => ({ signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null) }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => "the database" }));
vi.mock("../../../artifacts/artifacts.ts", () => ({ screenCapture: async (...args: unknown[]) => (state.asked.push(args), state.capture) }));
vi.mock("../../../server/shell.ts", () => ({
  shellFor: async (member: Member) => {
    state.shells.push(member);
    return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, projects: [{ id: "p1", name: "Acme", address: "app.acme.test" }], runs: 4 } };
  },
}));

const { default: CapturePage } = await import("./page.tsx");
const ID = "11111111-1111-4111-8111-111111111111";
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const open = () => CapturePage({ params: Promise.resolve({ id: ID }) });
const member: Member = { userId: "u1", name: "Ana Lopez", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };
const capture = { id: ID, runId: RUN, runNumber: 17, projectId: "p1", replay: false, findingTitle: "Saving fails" };

beforeEach(() => {
  state.member = null;
  state.capture = null;
  state.asked = [];
  state.shells = [];
});

test("someone signed out, or no longer a member of the workspace, is sent to sign in before anything is looked up", async () => {
  await expect(open()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.asked).toEqual([]);
});

test("a capture the member's workspace does not have is not found", async () => {
  state.member = member;
  await expect(open()).rejects.toMatchObject({ notFound: true });
  expect(state.asked).toEqual([["the database", "org-1", ID]]);
  expect(state.shells).toEqual([]);
});

test("a capture opens at an address that stays valid, under its finding's title, leading back to its run and project, and offers the original at full size", async () => {
  state.member = member;
  state.capture = capture;
  const html = renderToStaticMarkup(await open());
  const crumbs = html.match(/<nav aria-label="Breadcrumb".*?<\/nav>/)?.[0] ?? "";
  expect(crumbs).toMatch(new RegExp(`<a href="/projects/p1"[^>]*>Acme</a>.*<a href="/runs/${RUN}"[^>]*>Run 0017</a>.*<li aria-current="page"[^>]*>Screen capture</li>`));
  expect(html).toMatch(/<h1[^>]*>Saving fails<\/h1>/);
  expect(html).toContain(">Screen capture · when reported</p>");
  expect(html).toMatch(new RegExp(`<a href="/api/artifacts/${ID}" target="_blank" rel="noreferrer" tabindex="-1" class="[^"]*\\bmax-w-\\[1282px\\][^"]*"><img src="/api/artifacts/${ID}" alt="The page when “Saving fails” was reported" width="1280" height="720" class="[^"]*\\bborder\\b[^"]*"/><span class="sr-only"> \\(opens the original in a new tab\\)</span></a>`));
  expect(html).not.toContain("max-w-3xl");
  expect(html).toContain(">Passwords and other secrets are blacked out in screen captures.</span>");
  expect(html).toMatch(new RegExp(`<a href="/api/artifacts/${ID}" target="_blank" rel="noreferrer" class="[^"]*">Open the original, 1280 × 720<span aria-hidden="true"> ↗</span><span class="sr-only"> \\(opens in a new tab\\)</span></a>`));
  expect(state.shells).toEqual([member]);
});

test("a replay's capture says where the replay ended", async () => {
  state.member = member;
  state.capture = { ...capture, replay: true };
  const html = renderToStaticMarkup(await open());
  expect(html).toContain(">Screen capture · where the replay ended</p>");
  expect(html).toContain('alt="The page where the replay of “Saving fails” ended"');
});
