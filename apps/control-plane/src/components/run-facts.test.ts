import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunLine } from "../projects/overview.ts";
import { LocalTime } from "./local-time.tsx";
import { RunFacts } from "./run-facts.tsx";

const run: RunLine = {
  id: "r1", number: 7, status: "succeeded", createdAt: new Date("2026-09-25T18:50:00.000Z"),
  costUsd: 0.354, tokenCap: null, tokensUsed: 0, confirmed: 2, goalsReached: 18, goalsTotal: 24,
};
const text = (r: RunLine) => renderToStaticMarkup(createElement(RunFacts, { run: r })).replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

test("a run reads as its status, confirmed defects, goals reached, cost and date", () => {
  expect(text(run)).toMatch(/^\|Complete\|2 confirmed defects\|18 of 24 goals reached\|\$0\.35\|25 Sept? 2026, 18:50 UTC\|$/);
});

test("each run status has the word the run page uses", () => {
  const word = (status: string) => text({ ...run, status }).split("|")[1];
  expect(["succeeded", "stopped_budget", "cancelled", "failed", "running", "queued"].map(word)).toEqual(["Complete", "Stopped at cap", "Cancelled", "Failed", "Live", "Queued"]);
});

test("one confirmed defect is singular, and a run on an unpriced model shows its tokens instead of a cost", () => {
  const html = text({ ...run, confirmed: 1, tokenCap: 2_000_000, tokensUsed: 1_234_567, costUsd: 0 });
  expect(html).toContain("|1 confirmed defect|");
  expect(html).toContain("|1.23M tokens|");
  expect(html).not.toContain("$");
});

test("a date carries its exact moment for the browser, which shows it in the viewer's time zone", () => {
  const html = renderToStaticMarkup(createElement(LocalTime, { iso: "2026-09-25T18:50:00.000Z" }));
  expect(html).toMatch(/^<time dateTime="2026-09-25T18:50:00.000Z">25 Sept? 2026, 18:50 UTC<\/time>$/);
});
