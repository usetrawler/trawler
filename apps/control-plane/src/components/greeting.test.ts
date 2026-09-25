import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const browser = vi.hoisted(() => ({ snapshot: (): string => "" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useSyncExternalStore: <T>(subscribe: (onChange: () => void) => () => void, client: () => T, server?: () => T) => {
      browser.snapshot = client as () => string;
      return react.useSyncExternalStore(subscribe, client, server);
    },
  };
});

const { Greeting, partOfDay } = await import("./greeting.tsx");
const zone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

test("the server greets without guessing the viewer's time of day, so hydration cannot disagree", () => {
  expect(renderToStaticMarkup(createElement(Greeting, { name: "Ana" }))).toBe("Welcome back, Ana");
});

test("in the browser the greeting follows the viewer's own clock, not UTC", () => {
  renderToStaticMarkup(createElement(Greeting, { name: "Ana" }));
  process.env.TZ = "Asia/Tokyo";
  vi.useFakeTimers({ now: new Date("2026-09-25T00:30:00Z") });
  expect(browser.snapshot()).toBe("Good morning, Ana");
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  expect(browser.snapshot()).toBe("Good evening, Ana");
});

test("the day turns at five, noon and six", () => {
  expect([4, 5, 11, 12, 17, 18, 23, 0].map(partOfDay)).toEqual([
    "Good evening", "Good morning", "Good morning", "Good afternoon", "Good afternoon", "Good evening", "Good evening", "Good evening",
  ]);
});
