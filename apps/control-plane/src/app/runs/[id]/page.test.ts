import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ access: { signedIn: false } as unknown, asked: [] as Array<[string | null, string]> }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../server/runs.ts", () => ({ runFor: async (headers: Headers, id: string) => { state.asked.push([headers.get("cookie"), id]); return state.access; } }));
vi.mock("../../../runs/report.ts", () => ({ runView: () => ({}) }));
vi.mock("./run-live.tsx", () => ({ RunLive: () => null }));

const { default: RunPage } = await import("./page.tsx");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const open = () => RunPage({ params: Promise.resolve({ id: ID }) });
const member = { userId: "u1", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };

beforeEach(() => {
  state.access = { signedIn: false };
  state.asked = [];
});

test("a visitor who is not signed in, or no longer belongs to the workspace, is sent to sign in", async () => {
  await expect(open()).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.asked).toEqual([["session=ana", ID]]);
});

test("a run that is not in the member's workspace is not found", async () => {
  state.access = { signedIn: true, member, run: null };
  await expect(open()).rejects.toMatchObject({ notFound: true });
});

test("a run is shown inside its workspace's header", async () => {
  state.access = { signedIn: true, member, run: { id: ID } };
  const html = renderToStaticMarkup(await open());
  expect(html).toContain("Acme workspace");
  expect(html).toContain("ana@acme.test");
});
