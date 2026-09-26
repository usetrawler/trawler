import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

const { default: GlobalError } = await import("./global-error.tsx");
const { THEME_SCRIPT } = await import("../components/theme.ts");

test("the error page that replaces the whole app applies the remembered theme too", () => {
  const html = renderToStaticMarkup(createElement(GlobalError, { error: new Error("boom"), reset: () => {} }));
  expect(html).toMatch(new RegExp(`^<html lang="en"><head><script type="text/javascript">${THEME_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</script></head><body`));
});
