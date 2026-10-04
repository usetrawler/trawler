import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunFilter, RunLine } from "../../projects/overview.ts";
import { parsePlanQuery, parseRunsQuery, RunsView } from "./runs-view.tsx";

const run: RunLine = {
  id: "r1", number: 12, status: "failed", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 0.2, tokenCap: null, tokensUsed: 0,
  confirmed: 0, unchecked: false, goalsReached: 0, goalsTotal: 3, projectId: "p1", projectName: "Acme", projectSite: null, planName: null,
};

const render = (over: { show?: RunFilter; runs?: RunLine[]; olderThan?: number | null; paged?: boolean; scope?: "workspace" | "project" } = {}) => renderToStaticMarkup(createElement(RunsView, {
  head: createElement("h1", null, "Every run, newest first."), basePath: "/runs",
  show: over.show ?? "all", counts: { all: 60, completed: 48, attention: 11 }, runs: over.runs ?? [run], olderThan: over.olderThan ?? null, paged: over.paged ?? false, scope: over.scope,
}));
const filters = (html: string) => [...(html.match(/<nav aria-label="Filter runs".*?<\/nav>/)?.[0] ?? "").matchAll(/<a href="([^"]*)"( aria-current="page")?[^>]*>([^<]*) <span[^>]*>(\d+)<\/span><\/a>/g)]
  .map((m) => ({ href: m[1], current: Boolean(m[2]), label: m[3], count: m[4] }));
const pages = (html: string) => [...(html.match(/<nav aria-label="Run history pages".*?<\/nav>/)?.[0] ?? "").matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2], m[1]]);

describe("RunsView", () => {
  it("offers all runs, the completed ones and the ones that need attention, each with its count", () => {
    expect(filters(render())).toEqual([
      { href: "/runs", current: true, label: "All", count: "60" },
      { href: "/runs?show=completed", current: false, label: "Completed", count: "48" },
      { href: "/runs?show=attention", current: false, label: "Needs attention", count: "11" },
    ]);
    expect(filters(render({ show: "attention" })).map((f) => f.current)).toEqual([false, false, true]);
  });

  it("sets the chosen filter apart by weight as well as by its border colour", () => {
    const chips = (render({ show: "completed" }).match(/<nav aria-label="Filter runs".*?<\/nav>/)?.[0] ?? "").match(/<a [^>]*>/g) ?? [];
    expect(chips.map((chip) => /\bfont-semibold\b/.test(chip))).toEqual([false, true, false]);
    expect(chips.map((chip) => /\bborder-action\b/.test(chip))).toEqual([false, true, false]);
  });

  it("shows the page's own head above the filters, and lists the runs", () => {
    const html = render();
    expect(html).toMatch(/^<div><h1>Every run, newest first\.<\/h1><nav aria-label="Filter runs"/);
    expect(html).toContain('href="/runs/0012"');
  });

  it("pages to older runs and back to the newest, keeping the filter", () => {
    expect(pages(render({ olderThan: 12 }))).toEqual([["Older runs", "/runs?before=12"]]);
    expect(pages(render({ show: "attention", olderThan: 12, paged: true }))).toEqual([["Newest runs", "/runs?show=attention"], ["Older runs", "/runs?show=attention&amp;before=12"]]);
    expect(pages(render({ paged: true }))).toEqual([["Newest runs", "/runs"]]);
    expect(render()).not.toContain("Run history pages");
  });

  it("says why the list is empty", () => {
    expect(render({ runs: [] })).toContain("No runs yet. Start one from a project&#x27;s plan.");
    expect(render({ runs: [], show: "completed" })).toContain("No run has completed yet.");
    expect(render({ runs: [], show: "attention" })).toContain("No run needs attention.");
    expect(render({ runs: [], paged: true })).toContain("There are no older runs here.");
  });

  it("inside one project, points to its plan when it has no runs and leads each row with the date", () => {
    expect(render({ runs: [], scope: "project" })).toContain("No runs yet. Start one from the plan.");
    expect(render({ runs: [], scope: "project", show: "attention" })).toContain("No run needs attention.");
    expect(render({ scope: "project" })).not.toContain(">Acme</strong>");
    expect(render()).toContain(">Acme</strong>");
  });
});

describe("parseRunsQuery", () => {
  it("reads the filter and the page from the address", () => {
    expect(parseRunsQuery({ show: "completed", before: "40" })).toEqual({ show: "completed", before: 40 });
    expect(parseRunsQuery({ show: "attention" })).toEqual({ show: "attention", before: undefined });
  });

  it("falls back to all runs from the newest for anything else", () => {
    for (const show of [undefined, "all", "running", "", ["completed", "attention"]]) expect(parseRunsQuery({ show }).show).toBe("all");
    for (const before of [undefined, "0", "-3", "4.5", "abc", "2147483648", "01", ["3", "4"]]) expect(parseRunsQuery({ before }).before).toBeUndefined();
    expect(parseRunsQuery({ before: "2147483647" }).before).toBe(2_147_483_647);
  });
});

describe("RunsView, a project with several plans", () => {
  const plans = [{ id: "pl-1", name: "Plan 1" }, { id: "pl-2", name: "Invitations" }];
  const html = (plan?: string, show: RunFilter = "all") => renderToStaticMarkup(createElement(RunsView, {
    head: null, basePath: "/projects/p1/runs", show, counts: { all: 3, completed: 2, attention: 1 }, runs: [run], olderThan: 5, paged: false, scope: "project", plans, ...(plan ? { plan } : {}),
  }));
  const planLinks = (markup: string) => [...(markup.match(/<nav aria-label="Runs of a plan".*?<\/nav>/)?.[0] ?? "").matchAll(/<a href="([^"]*)"( aria-current="page")?[^>]*>([^<]*)<\/a>/g)].map((m) => [m[3], m[1], Boolean(m[2])]);

  it("offers all plans and each plan, marks the open one, and keeps the plan in the status filters and the paging", () => {
    expect(planLinks(html())).toEqual([["All plans", "/projects/p1/runs", true], ["Plan 1", "/projects/p1/runs?plan=pl-1", false], ["Invitations", "/projects/p1/runs?plan=pl-2", false]]);
    expect(planLinks(html("pl-2", "attention"))).toEqual([["All plans", "/projects/p1/runs?show=attention", false], ["Plan 1", "/projects/p1/runs?show=attention&amp;plan=pl-1", false], ["Invitations", "/projects/p1/runs?show=attention&amp;plan=pl-2", true]]);
    expect(filters(html("pl-2")).map((f) => f.href)).toEqual(["/projects/p1/runs?plan=pl-2", "/projects/p1/runs?show=completed&amp;plan=pl-2", "/projects/p1/runs?show=attention&amp;plan=pl-2"]);
    expect(pages(html("pl-2"))).toEqual([["Older runs", "/projects/p1/runs?before=5&amp;plan=pl-2"]]);
  });

  it("offers no plan filter to a project with one plan, and ignores a plan the project does not have", () => {
    expect(renderToStaticMarkup(createElement(RunsView, { head: null, basePath: "/p", show: "all", counts: { all: 0, completed: 0, attention: 0 }, runs: [], olderThan: null, paged: false, scope: "project", plans: [plans[0]!] }))).not.toContain("Runs of a plan");
    expect(parsePlanQuery({ plan: "pl-2" }, plans)).toBe("pl-2");
    expect(parsePlanQuery({ plan: "other" }, plans)).toBeUndefined();
    expect(parsePlanQuery({ plan: ["pl-2"] }, plans)).toBeUndefined();
    expect(parsePlanQuery({}, plans)).toBeUndefined();
  });
});
