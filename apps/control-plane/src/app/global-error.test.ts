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
const press = (error: Error) => (nodes(GlobalError({ error, reset: props.reset })).find((node) => node.type === "button")!.props!.onClick as () => void)();

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
  for (const effect of react.effects) effect();
  expect(sentry.captureException).toHaveBeenCalledOnce();
  (nodes(GlobalError({ error: new Error("boom"), reset })).find((node) => node.type === "button")!.props!.onClick as () => void)();
  expect(reset).toHaveBeenCalledOnce();
});

test("a page left open across an update says so and reloads, since trying again cannot work until then, and nothing is reported", () => {
  const outdated = new UnrecognizedActionError("Server action not found.");
  expect(text(renderToStaticMarkup(createElement(GlobalError, { error: outdated, reset: props.reset })))).toBe("Trawler was updated since this page opened. Reload the page to carry on. Reload the page →");
  for (const effect of react.effects) effect();
  expect(sentry.captureException).not.toHaveBeenCalled();
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  press(outdated);
  expect(reload).toHaveBeenCalledOnce();
});
