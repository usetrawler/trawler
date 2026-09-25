import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ member: null as { userId: string; email: string; orgId: string; orgName: string; role: string } | null }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=ana" }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  signedInMember: async (headers: Headers) => (headers.get("cookie") === "session=ana" ? state.member : null),
}));
vi.mock("./new-project-form.tsx", () => ({ NewProjectForm: () => null }));

const { default: NewProjectPage } = await import("./page.tsx");

beforeEach(() => {
  state.member = { userId: "u1", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };
});

test("a visitor who is not signed in, or no longer belongs to any workspace, is sent to sign in", async () => {
  state.member = null;
  await expect(NewProjectPage()).rejects.toMatchObject({ to: "/sign-in" });
});

test("the new project page is marked as the one the person is on, and Sign out is in the header once", async () => {
  const html = renderToStaticMarkup(await NewProjectPage());
  expect(html).toContain("Acme workspace");
  expect(html).toMatch(/<a href="\/new" aria-current="page"[^>]*>New project<\/a>/);
  expect(html.match(/>Sign out</g)).toHaveLength(1);
  expect(html.indexOf(">Sign out<")).toBeLessThan(html.indexOf("</header>"));
});
