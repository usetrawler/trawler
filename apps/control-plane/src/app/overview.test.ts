import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectLine, RunLine } from "../projects/overview.ts";
import type { OpenFinding } from "../projects/project-home.ts";
import { Overview, workspaceHeadline } from "./overview.tsx";

const run = (over: Partial<RunLine> = {}): RunLine => ({
  startedVia: null, origin: "app",
  id: "r9", number: 9, status: "succeeded", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 0.4, tokenCap: null, tokensUsed: 0,
  confirmed: 2, unchecked: false, goalsReached: 4, goalsTotal: 6, projectId: "p1", projectName: "Acme", projectSite: null, planName: null, ...over,
});
const acme: ProjectLine = { id: "p1", name: "Acme Invoices", targetUrl: "https://app.acme.test/billing", site: null, lastRun: run() };
const fresh: ProjectLine = { id: "p2", name: "Globex", targetUrl: "https://shop.globex.test/", site: null, lastRun: null };
const finding = (projectId: string, key = "f1"): OpenFinding => ({ projectId, key, title: "Totals are wrong", severity: "high", person: "Maya", source: "Plan 1", runNumber: 9, reportedAt: new Date("2026-09-25T12:40:00Z") });

const render = (projects: ProjectLine[], recent: RunLine[] = [], findings: OpenFinding[] = [], going: RunLine[] = []) =>
  renderToStaticMarkup(createElement(Overview, { workspace: "acme-org", projects, recent, findings, going }));

describe("Overview", () => {
  it("names the workspace, says what is open and lists projects with their latest result", () => {
    const html = render([acme, fresh], [], [finding("p1")]);
    expect(html).toContain(">acme-org</p>");
    expect(html).toContain(">1 confirmed defect is open, in Acme Invoices.</h1>");
    expect(html).toMatch(/<a href="\/findings"[^>]*>Open Findings<\/a>/);
    expect(html).toContain('<ul aria-label="Projects"');
    expect(html).toContain('href="/projects/p1/overview"');
    expect(html).toContain('href="/projects/p2/overview"');
    expect(html).toContain('href="/runs/new"');
    expect(html).toContain(">app.acme.test</span>");
    expect(html).toContain('href="/runs/0009"');
    expect(html).toContain(">2 confirmed</span>");
    expect(html).toContain(">No runs yet</span>");
    expect(html).not.toMatch(/Good (morning|afternoon|evening)|Welcome back/);
  });

  it("shows when the latest run failed or its findings could not be checked", () => {
    const html = render([{ ...acme, lastRun: run({ status: "failed", unchecked: true }) }]);
    expect(html).toContain("text-bad\">Failed</span>");
    expect(render([{ ...acme, lastRun: run({ unchecked: true }) }])).toContain(">Not checked: every replay failed</span>");
  });

  it("lists recent runs with a link to all runs, and leaves the section out before the first run", () => {
    const html = render([acme], [run(), run({ id: "r8", number: 8 })]);
    expect(html).toContain('<h2 id="recent-runs"');
    expect(html).toMatch(/<a href="\/runs"[^>]*>All runs<\/a>/);
    expect(html.match(/href="\/runs\/\d{4}"/g)).toEqual(["/runs/0009", "/runs/0009", "/runs/0008"].map((href) => `href="${href}"`));
    expect(render([fresh])).not.toContain("recent-runs");
  });

  it("shows the runs that are going now, with their project", () => {
    const html = render([acme], [], [], [run({ id: "r10", number: 10, status: "running" })]);
    expect(html).toContain("Acme · Run 0010 is running");
  });
});

describe("workspaceHeadline", () => {
  it("follows what is open across projects", () => {
    expect(workspaceHeadline([], [fresh])).toBe("No runs yet.");
    expect(workspaceHeadline([], [acme, fresh])).toBe("No confirmed defects are open.");
    expect(workspaceHeadline([finding("p1"), finding("p1", "f2")], [acme])).toBe("2 confirmed defects are open, in Acme Invoices.");
    const many = ["a", "b", "c", "d"].map((id): ProjectLine => ({ ...acme, id, name: id.toUpperCase() }));
    expect(workspaceHeadline(many.map((p) => finding(p.id)), many)).toBe("4 confirmed defects are open, across 4 projects.");
    expect(workspaceHeadline(many.slice(0, 3).map((p) => finding(p.id)), many)).toBe("3 confirmed defects are open, in A, B and C.");
  });
});
