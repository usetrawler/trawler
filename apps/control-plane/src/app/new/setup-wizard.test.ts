import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("./actions.ts", () => ({ readProductAction: vi.fn(), describeProductAction: vi.fn(), proposePeopleAction: vi.fn() }));
const { featuresFrom, SetupWizard } = await import("./setup-wizard.tsx");

const summary = { name: "Acme", description: "d", features: [{ title: "Submit a pitch", summary: "a" }, { title: "Review pitches", summary: "b" }] };

test("a new setup preselects the best match, the first feature", () => {
  expect(featuresFrom(summary).map((f) => [f.title, f.chosen])).toEqual([["Submit a pitch", true], ["Review pitches", false]]);
});

test("changing a project's features starts from what it chose before, its own additions included", () => {
  expect(featuresFrom(summary, ["review pitches", "Invite a co-founder"]).map((f) => [f.title, f.chosen])).toEqual([
    ["Submit a pitch", false],
    ["Review pitches", true],
    ["Invite a co-founder", true],
  ]);
});

test("a new project asks only for the product's address", () => {
  const html = renderToStaticMarkup(createElement(SetupWizard, {}));
  expect(html).toContain('name="url"');
  expect(html).toContain("Analyse product");
  expect(html).not.toContain('name="focus"');
});
