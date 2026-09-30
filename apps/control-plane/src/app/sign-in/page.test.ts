import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ person: null as null | { member: unknown } | { newcomer: unknown } }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../server/auth.ts", () => ({ signedInPerson: async () => state.person, signInProviders: () => ["dev"] }));

const { default: SignInPage } = await import("./page.tsx");

test("a member already signed in goes home, which knows whether the workspace has projects", async () => {
  state.person = { member: { email: "ana@acme.test" } };
  await expect(SignInPage({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ to: "/" });
});

test("someone signed in who has not chosen a workspace yet goes to the choice", async () => {
  state.person = { newcomer: { email: "new@acme.test" } };
  await expect(SignInPage({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ to: "/welcome" });
});

test("a visitor sees the ways to sign in", async () => {
  state.person = null;
  expect(renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }))).toContain("Continue with the development account");
});

test("signing in links to the terms and the privacy notice on usetrawler.com, each opening in a new tab", async () => {
  state.person = null;
  const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }));
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).toContain("By signing in you accept the Terms ↗ (opens in a new tab) and the Privacy notice ↗ (opens in a new tab).");
  expect(html).toMatch(/<a href="https:\/\/usetrawler\.com\/terms\/" target="_blank"[^>]*>Terms/);
  expect(html).toMatch(/<a href="https:\/\/usetrawler\.com\/privacy\/" target="_blank"[^>]*>Privacy notice/);
});
