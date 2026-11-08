import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunLine } from "../../../../projects/overview.ts";
import type { PullRequestLine } from "../../../../projects/project-home.ts";
import { PullRequestTable } from "./pull-request-table.tsx";

const run = (number: number, patch: Partial<RunLine> = {}): RunLine => ({
  id: `r${number}`, number, status: "succeeded", createdAt: new Date(), costUsd: 0, tokenCap: null, tokensUsed: 0, confirmed: 0, unchecked: false, goalsReached: 0, goalsTotal: 0,
  projectId: "p1", projectName: "Recurro", projectSite: null, planName: null, startedVia: null, origin: "api", ...patch,
});
const render = (lines: PullRequestLine[]) => renderToStaticMarkup(createElement(PullRequestTable, { projectId: "p1", lines }));

test("each pull request is a row: number, title linking to the pull request, its plan, the latest run's result and the run", () => {
  const html = render([
    { number: 22, title: "feat: search charges by name", url: "https://github.com/acme/app/pull/22", plan: { id: "pr-plan", label: "v17", ofPullRequest: true }, run: run(293, { confirmed: 1 }) },
    { number: 13, title: null, url: null, plan: { id: null, label: "v6", ofPullRequest: true }, run: run(251, { status: "skipped" }) },
  ]);
  expect(html).toMatch(/<th scope="col"[^>]*>PR<\/th><th scope="col"[^>]*>Title<\/th><th scope="col"[^>]*>Plan<\/th><th scope="col"[^>]*>Latest run<\/th><th scope="col"[^>]*>Run<\/th>/);
  expect(html).toMatch(/>#22<\/td><td[^>]*><a href="https:\/\/github\.com\/acme\/app\/pull\/22" target="_blank" rel="noreferrer"[^>]*>feat: search charges by name<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/);
  expect(html).toMatch(/<a href="\/projects\/p1\?plan=pr-plan"[^>]*>v17<span class="sr-only">, the plan for pull request #22<\/span><\/a>/);
  expect(html).toMatch(/<td class="[^"]*font-medium text-ink[^"]*">1 confirmed<\/td><td[^>]*><a href="\/runs\/0293"[^>]*>Run 0293<\/a>/);
  expect(html).toMatch(/>#13<\/td><td[^>]*>Pull request #13<\/td><td[^>]*>v6<\/td><td class="[^"]*text-muted[^"]*">Skipped: nothing to test in the UI<\/td>/);
});

test("an address that is not a web page is shown as text, never as a link", () => {
  const html = render([{ number: 5, title: "feat: x", url: "javascript:alert(1)", plan: { id: null, label: "v1", ofPullRequest: true }, run: run(9) }]);
  expect(html).not.toContain("javascript:");
  expect(html).toMatch(/>#5<\/td><td[^>]*>feat: x<\/td>/);
});

test("without pull requests the page says where they come from", () => {
  expect(render([])).toContain("No pull requests yet. A run your CI job starts for a pull request is listed here.");
});
