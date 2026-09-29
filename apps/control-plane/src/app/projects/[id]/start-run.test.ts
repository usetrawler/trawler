import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Recognised } from "../../../components/key-fields.tsx";
import { Estimate, StartRun } from "./start-run.tsx";

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

test("the estimate spans OpenRouter's providers, names the turns, and says how many steps a turn gets", () => {
  const text = (props: Parameters<typeof Estimate>[0]) => renderToStaticMarkup(createElement(Estimate, props)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const listed = { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 };
  const range = { low: { promptUsdPerMtok: 0.035, completionUsdPerMtok: 0.29 }, high: { promptUsdPerMtok: 0.375, completionUsdPerMtok: 1.2 } };
  expect(text({ price: listed, range, goalsPerTurn: [6, 6, 6, 6], personas: 4, modelChosen: true })).toBe(
    "Estimated run $0.15–$2.55 4 people, plus about $0.08 for each defect that gets replayed. A turn gets 20 steps for each of its goals and 10 more, 120 at most.",
  );
  expect(text({ price: listed, range: null, goalsPerTurn: [2, 1, 1], personas: 2, modelChosen: true })).toContain("2 people taking 3 turns");
  expect(text({ price: null, range: null, goalsPerTurn: [1], personas: 1, modelChosen: true })).toContain("the run stops after 3 million tokens instead");
});

test("the cap's hint says the last call can take a run slightly past it, as the proxy counts a call once it has happened", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore: true }));
  expect(html).toContain("Hard cap (USD). The run stops once it reaches it, and the last call can take it slightly past; findings so far are kept.");
});
