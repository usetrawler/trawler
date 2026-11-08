import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunLine } from "../../../../projects/overview.ts";
import type { OpenFinding, PullRequestLine } from "../../../../projects/project-home.ts";
import { ProjectHomeView } from "./home-view.tsx";

const run = (number: number, patch: Partial<RunLine> = {}): RunLine => ({
  id: `r${number}`, number, status: "succeeded", createdAt: new Date("2026-11-07T09:00:00Z"), costUsd: 0.2, tokenCap: null, tokensUsed: 0, confirmed: 0, unchecked: false, goalsReached: 3, goalsTotal: 4,
  projectId: "p1", projectName: "Recurro", projectSite: null, planName: null, startedVia: null, origin: "app", ...patch,
});
const finding = (key: string, patch: Partial<OpenFinding> = {}): OpenFinding => ({ key, title: `Title ${key}`, severity: "high", person: "Maya", source: "PR #21", runNumber: 292, reportedAt: new Date("2026-11-07T10:00:00Z"), ...patch });
const pr = (number: number, r: RunLine, patch: Partial<PullRequestLine> = {}): PullRequestLine => ({ number, title: `feat: change ${number}`, url: null, plan: { id: "pp", label: "v16", ofPullRequest: true }, run: r, ...patch });
const render = (props: Partial<Parameters<typeof ProjectHomeView>[0]> = {}) => renderToStaticMarkup(createElement(ProjectHomeView, { projectId: "p1", runs: 12, findings: [], going: [], pullRequests: [], pullRequestCount: 0, ...props }));

test("the home leads with how many confirmed defects are open, then lists each, linked to the finding in its run", () => {
  const html = render({ findings: [finding("maya:f1"), finding("devon:f2", { severity: "low", person: null, source: "Plan 1", runNumber: 293 })] });
  expect(html).toContain(">2 confirmed defects are open, from PR #21 and Plan 1.</p>");
  expect(html).toMatch(/<h2 id="open-findings"[^>]*>Findings <span[^>]*>2<\/span><\/h2>/);
  expect(html).toContain('href="/runs/0292#finding-maya%3Af1"');
  expect(html).toMatch(/>Title maya:f1<\/span>[\s\S]*?high<span class="sr-only"> severity<\/span><\/span><span aria-hidden="true">·<\/span>PR #21<span aria-hidden="true">·<\/span>Run 0292<span aria-hidden="true">·<\/span>Maya/);
  expect(html).toMatch(/Plan 1<span aria-hidden="true">·<\/span>Run 0293<\/span>/);
});

test("with nothing open the home says so, and a project without runs points at its plan", () => {
  expect(render()).toContain(">No confirmed defects are open.</p>");
  expect(render()).not.toContain("open-findings");
  const empty = render({ runs: 0 });
  expect(empty).toContain(">No runs yet.</p>");
  expect(empty).toMatch(/Check the <a href="\/projects\/p1"[^>]*>plan<\/a>, then start a run/);
  expect(empty).not.toContain("View run history");
});

test("a run that is going shows on one line with a way to watch it", () => {
  const html = render({ going: [run(300, { status: "running", savedPlan: { name: "PR #24 v16", title: null } }), run(301, { status: "queued" })] });
  expect(html).toMatch(/>Run 0300 is running<\/span><span[^>]*>PR #24 v16<\/span><span[^>]*>and 1 more<\/span><a href="\/runs\/0300"[^>]*>Watch<span class="sr-only"> Run 0300<\/span><\/a>/);
  expect(render()).not.toContain("Watch");
});

test("the latest three pull requests follow, each with its plan, its run and the result, and All leads to the rest", () => {
  const html = render({ pullRequests: [pr(24, run(300, { status: "running" })), pr(23, run(294, { status: "stopped_budget" })), pr(22, run(293, { confirmed: 1 }), { plan: { id: "pl1", label: "Plan 1", ofPullRequest: false } }), pr(21, run(292))], pullRequestCount: 12 });
  expect(html.match(/<li><a href="\/runs\/\d+" class="grid/g)).toHaveLength(3);
  expect(html).toMatch(/#24<\/span><span[^>]*><span[^>]*>feat: change 24<\/span><span[^>]*>plan v16 · Run 0300<\/span><\/span><span[^>]*text-muted[^>]*>Running<\/span>/);
  expect(html).toMatch(/>Plan 1 · Run 0293<\/span><\/span><span class="[^"]*font-medium text-ink[^"]*">1 confirmed<\/span>/);
  expect(html).toContain(">Stopped at cap · No defect confirmed<");
  expect(html).toMatch(/<a href="\/projects\/p1\/pull-requests"[^>]*>All 12<span class="sr-only"> pull requests<\/span><\/a>/);
  expect(render({ pullRequests: [pr(24, run(300))], pullRequestCount: 1 })).not.toContain("All 1");
});
