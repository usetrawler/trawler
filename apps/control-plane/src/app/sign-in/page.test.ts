import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ session: null as null | { user: { email: string } } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({ getAuth: () => ({ api: { getSession: async () => state.session } }), signInProviders: () => ["dev"] }));

const { default: SignInPage } = await import("./page.tsx");

test("someone already signed in goes home, which knows whether the workspace has projects", async () => {
  state.session = { user: { email: "ana@acme.test" } };
  await expect(SignInPage({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ to: "/" });
});

test("a visitor sees the ways to sign in", async () => {
  state.session = null;
  expect(renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }))).toContain("Continue with the development account");
});
