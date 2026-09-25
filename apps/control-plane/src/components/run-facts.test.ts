import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunLine } from "../projects/overview.ts";
import { RunFacts } from "./run-facts.tsx";

const run: RunLine = {
  id: "r1", number: 7, status: "succeeded", createdAt: new Date("2026-09-25T18:50:00.000Z"),
  costUsd: 0.354, tokenCap: null, tokensUsed: 0, confirmed: 2, goalsReached: 18, goalsTotal: 24,
};
const html = (r: RunLine) => renderToStaticMarkup(createElement(RunFacts, { run: r }));
const text = (r: RunLine) => html(r).replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

test("a run reads as its status, confirmed defects, goals reached, cost and date", () => {
  expect(text(run)).toBe("|Complete|2 confirmed defects|18 of 24 goals reached|$0.35|2026-09-25 18:50 UTC|");
  expect(html(run)).toContain('<time dateTime="2026-09-25T18:50:00.000Z">');
});

test("each run status has the word the run page uses, in its own colour", () => {
  const status = (s: string) => html({ ...run, status: s }).match(/<span class="([^"]*)">([^<]*)<\/span>/)!.slice(1);
  expect(["succeeded", "stopped_budget", "cancelled", "failed", "running", "queued"].map(status)).toEqual([
    [expect.stringMatching(/\btext-ok$/), "Complete"],
    [expect.stringMatching(/\btext-warn$/), "Stopped at cap"],
    [expect.stringMatching(/\btext-muted$/), "Cancelled"],
    [expect.stringMatching(/\btext-bad$/), "Failed"],
    [expect.stringMatching(/\btext-info$/), "Live"],
    [expect.stringMatching(/\btext-muted$/), "Queued"],
  ]);
});

test("one confirmed defect is singular, and a run on an unpriced model shows its tokens instead of a cost", () => {
  const facts = text({ ...run, confirmed: 1, tokenCap: 2_000_000, tokensUsed: 1_234_567, costUsd: 0 });
  expect(facts).toContain("|1 confirmed defect|");
  expect(facts).toContain("|1.23M tokens|");
  expect(facts).not.toContain("$");
});
