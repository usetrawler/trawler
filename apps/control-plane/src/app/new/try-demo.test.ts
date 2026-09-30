import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ state: null as { error: string } | null, pending: false, served: [] as unknown[] }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useActionState: (serve: unknown) => { react.served.push(serve); return [react.state, () => {}, react.pending]; } }));
const actions = vi.hoisted(() => ({ tryDemoAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { TryDemo, tryTheDemo } = await import("./try-demo.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");
const text = () => renderToStaticMarkup(createElement(TryDemo)).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

beforeEach(() => Object.assign(react, { state: null, pending: false, served: [] }));

test("the offer says what the demo is and what it opens with, and says when it is being set up", () => {
  expect(text()).toContain("No product at hand? Try our demo — Greenhouse, a small plant shop we run with a few bugs planted on purpose. It opens as a project with three people and their test accounts.");
  expect(renderToStaticMarkup(createElement(TryDemo))).toMatch(/<button[^>]*aria-describedby="demo-offer"[^>]*>Try our demo<\/button> <span id="demo-offer">/);
  react.pending = true;
  expect(renderToStaticMarkup(createElement(TryDemo))).toContain('<p role="status" class="sr-only">Setting up the demo…</p>');
  expect(new Set(react.served)).toEqual(new Set([tryTheDemo]));
});

test("a refusal is shown as an alert, and a page left open across an update is told to reload", async () => {
  react.state = { error: "The demo could not be set up. Try again in a moment." };
  expect(renderToStaticMarkup(createElement(TryDemo))).toContain('role="alert"');
  actions.tryDemoAction.mockRejectedValueOnce(new UnrecognizedActionError("gone"));
  expect(await tryTheDemo()).toEqual({ error: expect.stringContaining("Reload the page to try the demo.") });
  const other = new Error("boom");
  actions.tryDemoAction.mockRejectedValueOnce(other);
  await expect(tryTheDemo()).rejects.toBe(other);
});
