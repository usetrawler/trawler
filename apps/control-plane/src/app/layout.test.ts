import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/font/google", () => ({ Instrument_Sans: () => ({ variable: "sans" }), JetBrains_Mono: () => ({ variable: "mono" }) }));
vi.mock("../server/sentry.ts", () => ({ sentryMeta: () => null }));

const { default: RootLayout, viewport } = await import("./layout.tsx");
const { THEME_SCRIPT } = await import("../components/theme.ts");

test("every page under the root layout applies the remembered theme in its head, before anything paints", () => {
  const html = renderToStaticMarkup(createElement(RootLayout, null, "page"));
  expect(html).toContain(`<head><script type="text/javascript">${THEME_SCRIPT}</script></head><body`);
});

test("the root element lets the script's theme attribute differ from what the server rendered", () => {
  expect(RootLayout({ children: "page" }).props).toMatchObject({ lang: "en", suppressHydrationWarning: true });
});

test("a page that has not drawn yet, such as the blank shell before a not-found page, follows the system's light or dark setting", () => {
  expect(viewport).toEqual({ colorScheme: "light dark" });
});
