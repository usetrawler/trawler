import { expect, test, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[]);
vi.mock("../auth-client.ts", () => ({ authClient: { signIn: { social: async (options: unknown) => { calls.push(options); return {}; } } } }));

const { signInWith } = await import("./sign-in-buttons.tsx");

test("signing in comes back to the home page, which sends an empty workspace on to a new project", async () => {
  await signInWith("github");
  await signInWith("dev");
  expect(calls).toEqual([
    { provider: "github", callbackURL: "/", errorCallbackURL: "/sign-in" },
    { provider: "dev", callbackURL: "/", errorCallbackURL: "/sign-in" },
  ]);
});
