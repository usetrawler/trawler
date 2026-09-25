import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[]);
vi.mock("../auth-client.ts", () => ({ authClient: { signIn: { social: async (options: unknown) => { calls.push(options); return {}; } } } }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: <T>(initial: T) => [initial, () => {}] }));

const { SignInButtons } = await import("./sign-in-buttons.tsx");

test("every sign-in button comes back to the home page", async () => {
  const buttons = (SignInButtons({ providers: ["github", "dev"] }) as ReactElement<{ children: [ReactElement<{ onClick: () => Promise<void> }>[], unknown] }>).props.children[0];
  for (const button of buttons) await button.props.onClick();
  expect(calls).toEqual([
    { provider: "github", callbackURL: "/", errorCallbackURL: "/sign-in" },
    { provider: "dev", callbackURL: "/", errorCallbackURL: "/sign-in" },
  ]);
});
