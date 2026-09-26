import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Recognised } from "../../../components/key-fields.tsx";
import { StartRun } from "./start-run.tsx";

test("a member who cannot add the model key is told that an owner or admin can", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: false, authorisedBefore: false }));
  expect(html).toContain("Ask an owner or admin of this workspace to add a model key.");
});

test("the Start panel names the project it starts, since New run jumps straight to it", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore: false }));
  expect(html).toMatch(/<form id="start"[^>]*>.*>Start · <span class="text-ink">Acme Invoices<\/span><\/p>/);
});

test("a recognised key is named with the article its provider takes", () => {
  const said = (provider: "google" | "openrouter") => renderToStaticMarkup(createElement(Recognised, { provider })).replace(/<[^>]+>/g, "");
  expect(said("google")).toBe("Recognised as a Google key. Not right? Pick the provider below.");
  expect(said("openrouter")).toBe("Recognised as an OpenRouter key. Not right? Pick the provider below.");
});

test("a product that has had a run is not asked for the authorisation again; one without runs is", () => {
  const start = (authorisedBefore: boolean) => renderToStaticMarkup(createElement(StartRun, { projectId: "p1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore }));
  expect(start(false)).toContain('name="authorised"');
  expect(start(true)).not.toContain('name="authorised"');
  expect(start(true).replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'")).toContain("Confirmed when this product's first run started: it may be tested, and it is not a production system with real people's data.");
});
