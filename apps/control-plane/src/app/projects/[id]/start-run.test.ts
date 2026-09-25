import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Recognised, StartRun } from "./start-run.tsx";

test("a member who cannot add the model key is told that an owner or admin can", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: false }));
  expect(html).toContain("Ask an owner or admin of this workspace to add a model key.");
});

test("the Start panel names the project it starts, since New run jumps straight to it", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true }));
  expect(html).toMatch(/<form id="start"[^>]*>.*>Start · <span class="text-ink">Acme Invoices<\/span><\/p>/);
});

test("a recognised key is named with the article its provider takes", () => {
  const said = (provider: "google" | "openrouter") => renderToStaticMarkup(createElement(Recognised, { provider })).replace(/<[^>]+>/g, "");
  expect(said("google")).toBe("Recognised as a Google key. Not right? Pick the provider below.");
  expect(said("openrouter")).toBe("Recognised as an OpenRouter key. Not right? Pick the provider below.");
});
