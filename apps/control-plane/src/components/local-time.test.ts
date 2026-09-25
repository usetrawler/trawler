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

const { LocalTime } = await import("./local-time.tsx");
const zone = process.env.TZ;
const render = (iso: string) => renderToStaticMarkup(createElement(LocalTime, { iso }));

afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

test("the server writes the exact moment in UTC, the same text on every engine, so hydration cannot disagree", () => {
  expect(render("2026-09-25T18:50:00.000Z")).toBe('<time dateTime="2026-09-25T18:50:00.000Z">2026-09-25 18:50 UTC</time>');
  expect(render("2026-01-05T03:07:00.000Z")).toContain(">2026-01-05 03:07 UTC<");
});

test("in the browser the date is shown in the viewer's own time zone", () => {
  render("2026-09-25T18:50:00.000Z");
  process.env.TZ = "Asia/Tokyo";
  expect(browser.snapshot()).toMatch(/^26 Sept? 2026, 03:50$/);
  process.env.TZ = "America/New_York";
  expect(browser.snapshot()).toMatch(/^25 Sept? 2026, 14:50$/);
});
