import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RunBreadcrumb } from "./run-breadcrumb.tsx";

const project = { id: "p1", name: "Recurro" };
const crumbs = (html: string) => [...html.matchAll(/<li[^>]*>(?:<a href="([^"]*)"[^>]*>)?([^<›]+)/g)].map((m) => [m[2], m[1] ?? null]);

test("a run made for a pull request leads back through the project's Pull requests, then the plan it used", () => {
  expect(crumbs(renderToStaticMarkup(createElement(RunBreadcrumb, { project, number: 300, plan: "PR #24 v5", fromPullRequest: true })))).toEqual([
    ["Projects", "/"], ["Recurro", "/projects/p1/overview"], ["Pull requests", "/projects/p1/pull-requests"], ["PR #24 v5", "/runs/0300/plan"], ["Run 0300", null],
  ]);
  expect(renderToStaticMarkup(createElement(RunBreadcrumb, { project, number: 12, plan: "Plan 1" }))).not.toContain("Pull requests");
  expect(renderToStaticMarkup(createElement(RunBreadcrumb, { number: 12, plan: "PR #24 v5", fromPullRequest: true }))).not.toContain("Pull requests");
});
