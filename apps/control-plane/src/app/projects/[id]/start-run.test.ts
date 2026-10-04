import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Recognised } from "../../../components/key-fields.tsx";
import { Estimate, OnUs, StartRun } from "./start-run.tsx";

test("a member who cannot add the model key is told that an owner or admin can", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: false, authorisedBefore: false }));
  expect(html).toContain("Ask an owner or admin of this workspace to add a model key.");
});

test("the Start panel names the project it starts, since New run jumps straight to it", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore: false }));
  expect(html).toMatch(/<form id="start"[^>]*>.*>Start · <span class="text-ink">Acme Invoices<\/span><\/p>/);
});

test("a recognised key is named with the article its provider takes", () => {
  const said = (provider: "google" | "openrouter") => renderToStaticMarkup(createElement(Recognised, { provider })).replace(/<[^>]+>/g, "");
  expect(said("google")).toBe("Recognised as a Google key. Not right? Pick the provider below.");
  expect(said("openrouter")).toBe("Recognised as an OpenRouter key. Not right? Pick the provider below.");
});

test("a product that has had a run is not asked for the authorisation again; one without runs is", () => {
  const start = (authorisedBefore: boolean) => renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore }));
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
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore: true }));
  expect(html).toContain("Hard cap (USD). The run stops once it reaches it, and the last call can take it slightly past; findings so far are kept.");
});

test("a refusal known when the page opens is said above the form, with the live run to open, and Start still asks again", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore: true, refusal: { message: "Run 0007 is still going on this project. Wait for it to finish or stop it, then start again.", activeRun: { id: "live-run", number: 7 } } }));
  expect(html).toContain('Run 0007 is still going on this project. Wait for it to finish or stop it, then start again. <a href="/runs/0007"');
  expect(html).toContain(">Open Run 0007</a>");
  expect(html.match(/<button type="submit"[^>]*>/)?.[0]).not.toMatch(/\sdisabled=""/);
});

test("while the first run on Trawler is left, Start offers it without key, model or cap fields, and even a member who cannot add a key may start it", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: false, authorisedBefore: false, firstRunOnUs: true }));
  expect(html).not.toContain('name="apiKey"');
  expect(html).not.toContain('name="model"');
  expect(html).not.toContain('name="budget"');
  expect(html).not.toContain("Ask an owner or admin");
  expect(html).not.toMatch(/<button type="submit" disabled=""/);
  expect(html).not.toContain("Pay with your own model key instead");
  expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("Your first run is on Trawler.");
});

test("the first run on Trawler says Trawler pays, what after, the fixed cap, and an estimate once the model's price is read", () => {
  const text = (range: Parameters<typeof OnUs>[0]["range"]) => renderToStaticMarkup(createElement(OnUs, { range, goalsPerTurn: [1, 1], personas: 2 })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
  const priced = { low: { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 }, high: { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 } };
  expect(renderToStaticMarkup(createElement(OnUs, { range: priced, goalsPerTurn: [1], personas: 1 }))).toContain('<input type="hidden" name="onUs" value="1"/>');
  expect(text(priced)).toContain("Trawler pays for the model: DeepSeek V4.1 Flash, up to $1.00, for up to 4 people. No key needed. After this run, runs are paid with your own model key.");
  expect(text(priced)).toContain("Hard cap $1.00, paid by Trawler.");
  expect(text(priced)).toMatch(/Estimated run \$0\.\d\d–\$0\.\d\d 2 people/);
  expect(text(priced)).not.toContain("The cap is below the estimate");
  const dear = { low: { promptUsdPerMtok: 3, completionUsdPerMtok: 15 }, high: { promptUsdPerMtok: 3, completionUsdPerMtok: 15 } };
  expect(text(dear)).toContain("The cap is below the estimate, so the run may stop before everyone finishes.");
  expect(text(undefined)).toContain("Estimated run … 2 people. Reading the model's price…");
  expect(text(null)).toContain("Estimated run Unknown 2 people. The model's price could not be read just now, so there is no estimate; the cap below still holds.");
  expect(text(null)).not.toContain("provider's billing");
});

test("an owner can pay with their own key instead of the first run on Trawler, and a saved key is named", () => {
  const offer = true;
  const owner = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme", personas: 2, keyHint: null, canManageKey: true, authorisedBefore: true, firstRunOnUs: offer }));
  expect(owner).toContain("Pay with your own model key instead");
  const saved = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme", personas: 2, keyHint: { provider: "openrouter", hint: "…a1b2", baseUrl: null }, canManageKey: false, authorisedBefore: true, firstRunOnUs: offer }));
  expect(saved).toContain("Pay with your OpenRouter key …a1b2 instead");
});

test("a plan with more people than the first run on Trawler takes is started with a key, and Start says why", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme", personas: 5, keyHint: null, canManageKey: true, authorisedBefore: true, firstRunOnUs: true }));
  expect(html).not.toContain('name="onUs"');
  expect(html).toContain('name="apiKey"');
  expect(html.replace(/<[^>]+>/g, "")).toContain("The first run on Trawler takes up to 4 people, and this plan has 5. Remove people from the plan to use it, or pay with your own model key.");
});

test("while a run on Trawler starts the button says Starting, and while a key is checked it says so", async () => {
  const { Submit } = await import("./start-run.tsx");
  const label = (checksKey: boolean) => renderToStaticMarkup(createElement(Submit, { pending: true, noticed: false, checksKey })).replace(/<[^>]+>/g, "");
  expect(label(false)).toBe("Starting…→");
  expect(label(true)).toBe("Checking the key…→");
});

test("the Start panel links to the terms and the privacy notice, whether or not the product had a run", () => {
  for (const authorisedBefore of [false, true]) {
    const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme", personas: 2, keyHint: null, canManageKey: true, authorisedBefore }));
    expect(html.replace(/<[^>]+>/g, "")).toContain("Hosted runs follow the Terms ↗ (opens in a new tab) and the Privacy notice ↗ (opens in a new tab).");
    expect(html).toContain('href="https://usetrawler.com/terms/"');
    expect(html).toContain('href="https://usetrawler.com/privacy/"');
  }
});

test("an account the beta list will refuse is told so in place of the offer and the fields, and cannot press Start", () => {
  const message = "Hosted runs are in private beta. Write to contact@usetrawler.com to get access.";
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: null, canManageKey: true, authorisedBefore: false, firstRunOnUs: true, closedBeta: message }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  expect(text).toContain(`Start · Acme Invoices ${message}`);
  expect(html).toMatch(/<button type="submit" disabled="" aria-describedby="start-blocked"/);
  expect(html).toContain(`<p id="start-blocked" class="border-l-2 border-warn pl-3 text-sm">${message}</p>`);
  expect(text).not.toContain("Your first run is on Trawler.");
  expect(html).not.toContain('name="apiKey"');
  expect(html).not.toContain('name="authorised"');
  expect(html).not.toContain('name="onUs"');
});

test("the Start panel names the plan it starts when the project has several", () => {
  const panel = (planLabel?: string) => renderToStaticMarkup(createElement(StartRun, { projectId: "p1", planId: "pl1", projectName: "Acme Invoices", ...(planLabel ? { planLabel } : {}), personas: 2, keyHint: null, canManageKey: true, authorisedBefore: true }));
  expect(panel("Invitations")).toContain("Acme Invoices</span> · <span class=\"text-ink\">Invitations</span>");
  expect(panel()).not.toContain("Invitations");
  expect(panel("Invitations")).toContain('<input type="hidden" name="planId" value="pl1"/>');
});
