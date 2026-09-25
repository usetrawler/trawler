import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({
  getAuth: () => ({ api: {
    getSession: async () => ({ user: { email: "ana@acme.test" }, session: { activeOrganizationId: "org-1" } }),
    getFullOrganization: async () => ({ name: "Acme workspace" }),
  } }),
}));
vi.mock("./new-project-form.tsx", () => ({ NewProjectForm: () => null }));

const { default: NewProjectPage } = await import("./page.tsx");

test("the new project page is marked as the one the person is on, and Sign out is in the header once", async () => {
  const html = renderToStaticMarkup(await NewProjectPage());
  expect(html).toMatch(/<a href="\/new" aria-current="page"[^>]*>New project<\/a>/);
  expect(html.match(/>Sign out</g)).toHaveLength(1);
  expect(html.indexOf(">Sign out<")).toBeLessThan(html.indexOf("</header>"));
});
