import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);
const react = vi.hoisted(() => ({ effects: [] as Array<() => void> }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useEffect: (effect: () => void) => { react.effects.push(effect); } }));

const { default: GlobalError } = await import("./global-error.tsx");
const { THEME_SCRIPT } = await import("../components/theme.ts");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");

const props = { error: new Error("boom"), reset: () => {} };
const text = (html: string) => html.replace(/<script[^>]*>.*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const press = (error: Error, reset: () => void) => (nodes(GlobalError({ error, reset })).find((node) => node.type === "button")!.props!.onClick as () => void)();
const report = () => {
  for (const effect of react.effects) effect();
};

beforeEach(() => {
  react.effects = [];
  sentry.captureException.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("the error page that replaces the whole app applies the remembered theme too", () => {
  const html = renderToStaticMarkup(createElement(GlobalError, props));
  expect(html).toMatch(new RegExp(`^<html lang="en"><head><script type="text/javascript">${THEME_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</script></head><body`));
});

test("the error page's root element lets the script's theme attribute differ from what the server rendered", () => {
  expect(GlobalError(props).props).toMatchObject({ lang: "en", suppressHydrationWarning: true });
});

test("an error in the browser is reported and offers to try again", () => {
  const reset = vi.fn();
  expect(text(renderToStaticMarkup(createElement(GlobalError, { error: new Error("boom"), reset })))).toBe("Something went wrong. Try again, or come back in a minute. Try again →");
  report();
  expect(sentry.captureException).toHaveBeenCalledOnce();
  press(new Error("boom"), reset);
  expect(reset).toHaveBeenCalledOnce();
});

test("an error the server already reported, which carries its digest, is not reported again", () => {
  renderToStaticMarkup(createElement(GlobalError, { error: Object.assign(new Error("boom"), { digest: "3141592653" }), reset: props.reset }));
  report();
  expect(sentry.captureException).not.toHaveBeenCalled();
});

test("a page left open across an update says so and reloads, since trying again cannot work until then, and nothing is reported", () => {
  const outdated = new UnrecognizedActionError("Server action not found.");
  const reset = vi.fn();
  expect(text(renderToStaticMarkup(createElement(GlobalError, { error: outdated, reset })))).toBe("Trawler has been updated since this page opened. Reload the page to carry on. Reload the page →");
  report();
  expect(sentry.captureException).not.toHaveBeenCalled();
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  press(outdated, reset);
  expect(reload).toHaveBeenCalledOnce();
  expect(reset).not.toHaveBeenCalled();
});
