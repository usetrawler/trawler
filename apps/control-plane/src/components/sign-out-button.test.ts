import { afterEach, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("../app/auth-client.ts", () => ({ authClient: { signOut: async () => { calls.push("sign out"); } } }));

const { SignOutButton } = await import("./sign-out-button.tsx");

afterEach(() => vi.unstubAllGlobals());

test("Sign out ends the session before it goes to the sign-in page", async () => {
  vi.stubGlobal("window", { location: { assign: (url: string) => calls.push(`go to ${url}`) } });
  const button = SignOutButton({});
  await button.props.onClick();
  expect(calls).toEqual(["sign out", "go to /sign-in"]);
});
