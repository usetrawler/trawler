import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useEffect: () => {} }));

const { default: GlobalError } = await import("./global-error.tsx");
const { THEME_SCRIPT } = await import("../components/theme.ts");

const props = { error: new Error("boom"), reset: () => {} };

test("the error page that replaces the whole app applies the remembered theme too", () => {
  const html = renderToStaticMarkup(createElement(GlobalError, props));
  expect(html).toMatch(new RegExp(`^<html lang="en"><head><script type="text/javascript">${THEME_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</script></head><body`));
});

test("the error page's root element lets the script's theme attribute differ from what the server rendered", () => {
  expect(GlobalError(props).props).toMatchObject({ lang: "en", suppressHydrationWarning: true });
});
