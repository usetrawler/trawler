import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/font/google", () => ({ Instrument_Sans: () => ({ variable: "sans" }), JetBrains_Mono: () => ({ variable: "mono" }) }));
vi.mock("../server/sentry.ts", () => ({ sentryMeta: () => null }));

const { default: RootLayout } = await import("./layout.tsx");
const { THEME_SCRIPT } = await import("../components/theme.ts");

test("every page applies the remembered theme in its head, before anything paints", () => {
  const html = renderToStaticMarkup(createElement(RootLayout, null, "page"));
  expect(html).toContain(`<head><script>${THEME_SCRIPT}</script></head><body`);
});
