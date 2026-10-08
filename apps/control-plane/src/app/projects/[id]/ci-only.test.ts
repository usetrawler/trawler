import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("./actions.ts", () => ({ confirmTestingAction: async () => ({}) }));

const { CiOnlyPanel } = await import("./ci-only.tsx");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();

test("a project on a private network asks once to allow runs from CI instead of offering a hosted run", () => {
  const html = renderToStaticMarkup(createElement(CiOnlyPanel, { projectId: "p1", projectName: "Recurro", host: "localhost:8080", confirmedAt: null }));
  expect(text(html)).toContain("localhost:8080 is on a private network, so Trawler's hosted runners cannot reach it.");
  expect(html).toContain('name="authorised"');
  expect(text(html)).toContain("Allow runs from CI");
  expect(text(html)).not.toContain("Start run");
});

test("once confirmed it says when, and that runs from CI can start", () => {
  const html = text(renderToStaticMarkup(createElement(CiOnlyPanel, { projectId: "p1", projectName: "Recurro", host: "localhost:8080", confirmedAt: "2026-10-09T06:00:00.000Z" })));
  expect(html).toContain("Confirmed on 2026-10-09: it may be tested");
  expect(html).toContain("Runs from CI can start.");
  expect(html).not.toContain("Allow runs from CI");
});
