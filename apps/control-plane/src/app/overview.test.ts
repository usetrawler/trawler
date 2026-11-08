import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectLine, RunLine } from "../projects/overview.ts";
import { firstName, Overview, overviewSubtitle } from "./overview.tsx";

const run = (over: Partial<RunLine> = {}): RunLine => ({
  startedVia: null, origin: "app",
  id: "r9", number: 9, status: "succeeded", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 0.4, tokenCap: null, tokensUsed: 0,
  confirmed: 2, unchecked: false, goalsReached: 4, goalsTotal: 6, projectId: "p1", projectName: "Acme", projectSite: null, planName: null, ...over,
});
const acme: ProjectLine = { id: "p1", name: "Acme Invoices", targetUrl: "https://app.acme.test/billing", site: null, lastRun: run() };
const fresh: ProjectLine = { id: "p2", name: "Globex", targetUrl: "https://shop.globex.test/", site: null, lastRun: null };

const render = (projects: ProjectLine[], recent: RunLine[] = []) => renderToStaticMarkup(createElement(Overview, { firstName: "Ana", projects, recent }));
describe("Overview", () => {
  it("lists projects with their latest activity and opens the project overview", () => {
    const html = render([acme, fresh]);
    expect(html).toContain(">Welcome back, Ana</p>");
    expect(html).toContain(">Projects</h1>");
    expect(html).toContain('<ul aria-label="Projects"');
    expect(html).toContain('href="/projects/p1/overview"');
    expect(html).toContain('href="/projects/p2/overview"');
    expect(html).toContain('href="/runs/new"');
    expect(html).toContain(">Acme Invoices</strong>");
    expect(html).toContain(">app.acme.test</small>");
    expect(html).toContain('href="/runs/0009"');
    expect(html).toContain("2 confirmed · 4/6 goals");
    expect(html).toContain(">No runs yet</span>");
  });

  it("shows when the latest run failed or its findings could not be checked", () => {
    const html = render([{ ...acme, lastRun: run({ status: "failed", unchecked: true }) }]);
    expect(html).toContain(">Failed</span>");
    expect(html).toContain("Findings not checked · 4/6 goals");
    expect(html).not.toContain("2 confirmed");
  });

  it("lists recent runs with a link to all runs, and leaves the section out before the first run", () => {
    const html = render([acme], [run(), run({ id: "r8", number: 8 })]);
    expect(html).toContain('<h2 id="recent-runs"');
    expect(html).toMatch(/<a href="\/runs"[^>]*>View all/);
    expect(html.match(/href="\/runs\/\d{4}"/g)).toEqual(['/runs/0009', '/runs/0009', '/runs/0008'].map((href) => `href="${href}"`));
    expect(render([fresh])).not.toContain("recent-runs");
  });
});

describe("overviewSubtitle", () => {
  it("says what the latest run found", () => {
    expect(overviewSubtitle([])).toBe("No runs yet. Start one from a project's plan.");
    expect(overviewSubtitle([run({ confirmed: 1 })])).toBe("1 defect was confirmed by replay in the latest run.");
    expect(overviewSubtitle([run({ confirmed: 3 })])).toBe("3 defects were confirmed by replay in the latest run.");
    expect(overviewSubtitle([run({ confirmed: 0 })])).toBe("No defect was confirmed in the latest run.");
    expect(overviewSubtitle([run({ confirmed: 0 }), run({ confirmed: 4 })])).toBe("No defect was confirmed in the latest run.");
    expect(overviewSubtitle([run({ confirmed: 0, unchecked: true })])).toBe("None of the defects in the latest run could be checked: every replay failed.");
    expect(overviewSubtitle([run({ status: "stopped_budget", confirmed: 0, unchecked: true })])).toBe("The latest run stopped at its cap; none of its defects could be checked: every replay failed.");
  });

  it("says when the latest run ended early, and what it confirmed before it stopped", () => {
    expect(overviewSubtitle([run({ status: "failed", confirmed: 0 })])).toBe("The latest run failed.");
    expect(overviewSubtitle([run({ status: "failed", confirmed: 1 })])).toBe("The latest run failed; 1 defect was confirmed by replay before it stopped.");
    expect(overviewSubtitle([run({ status: "stopped_budget", confirmed: 0 })])).toBe("The latest run stopped at its cap before any defect was confirmed.");
    expect(overviewSubtitle([run({ status: "stopped_budget", confirmed: 2 })])).toBe("The latest run stopped at its cap; 2 defects were confirmed by replay before it stopped.");
    expect(overviewSubtitle([run({ status: "cancelled", confirmed: 0 })])).toBe("The latest run was cancelled.");
    expect(overviewSubtitle([run({ status: "cancelled", confirmed: 2 })])).toBe("The latest run was cancelled; 2 defects were confirmed by replay before it stopped.");
  });

  it("says a run is going or waiting while one of the newest runs has not ended", () => {
    expect(overviewSubtitle([run(), run({ status: "running" })])).toBe("A run is going now.");
    expect(overviewSubtitle([run({ status: "queued" }), run({ status: "running" })])).toBe("A run is going now.");
    expect(overviewSubtitle([run({ status: "queued" })])).toBe("A run is waiting to start.");
    expect(overviewSubtitle([run({ status: "cancelled" }), run({ status: "queued" })])).toBe("A run is waiting to start.");
  });
});

describe("firstName", () => {
  it("uses the first word of the name, or of the email without a name", () => {
    expect(firstName({ name: "Ana Lopez", email: "ana@acme.test" })).toBe("Ana");
    expect(firstName({ name: "  ", email: "lee@acme.test" })).toBe("lee");
  });
});
