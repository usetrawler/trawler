import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectLine, RunLine } from "../projects/overview.ts";
import { firstName, Overview, overviewSubtitle } from "./overview.tsx";

const run = (over: Partial<RunLine> = {}): RunLine => ({
  id: "r9", number: 9, status: "succeeded", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 0.4, tokenCap: null, tokensUsed: 0,
  confirmed: 2, goalsReached: 4, goalsTotal: 6, projectId: "p1", projectName: "Acme", projectSite: null, ...over,
});
const acme: ProjectLine = { id: "p1", name: "Acme Invoices", targetUrl: "https://app.acme.test/billing", site: null, lastRun: run() };
const fresh: ProjectLine = { id: "p2", name: "Globex", targetUrl: "https://shop.globex.test/", site: null, lastRun: null };

const render = (projects: ProjectLine[], recent: RunLine[] = []) => renderToStaticMarkup(createElement(Overview, { firstName: "Ana", projects, recent }));
const hero = (html: string, id: string) => html.match(new RegExp(`<article aria-labelledby="project-${id}".*?</article>`))?.[0] ?? "";

describe("Overview", () => {
  it("greets the person and starts a new run from the most recently active project's plan", () => {
    const html = render([acme, fresh]);
    expect(html).toContain(">Welcome back, Ana</p>");
    expect(html).toContain(">Your products at a glance.</h1>");
    expect(html).toMatch(/<a href="\/projects\/p1#start"[^>]*>New run<span aria-hidden="true">→<\/span><\/a>/);
    expect(render([acme])).toContain(">Your product at a glance.</h1>");
  });

  it("shows each project with its host, the goals its last run reached and the defects it confirmed", () => {
    const card = hero(render([acme, fresh]), "p1");
    expect(card).toContain(">AI</span>");
    expect(card).toMatch(/<h2 id="project-p1"[^>]*><a href="\/projects\/p1"[^>]*>Acme Invoices<\/a><\/h2>/);
    expect(card).toMatch(/<a href="https:\/\/app\.acme\.test\/billing" target="_blank" rel="noreferrer" class="relative [^"]*\btruncate\b[^"]*">app\.acme\.test<span aria-hidden="true"> ↗<\/span><span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/);
    expect(card).toMatch(/><span aria-hidden="true">4 \/ 6<\/span><span class="sr-only">4 of 6<\/span><\/p><p[^>]*>goals reached<\/p>/);
    expect(card).toMatch(/>2<\/p><p[^>]*>defects in the last run<\/p>/);
    expect(card).toMatch(/<a href="\/runs\/r9"[^>]*>Open latest report<span class="sr-only"> for Acme Invoices<\/span>/);
  });

  it("marks confirmed defects with a shape as well as colour, and says one defect in the singular", () => {
    expect(hero(render([acme]), "p1")).toMatch(/<span aria-hidden="true" class="[^"]*bg-action"><\/span>2<\/p>/);
    const clean = hero(render([{ ...acme, lastRun: run({ confirmed: 0 }) }]), "p1");
    expect(clean).not.toContain('bg-action"></span>');
    expect(clean).toMatch(/font-bold">0<\/p><p[^>]*>defects in the last run<\/p>/);
    expect(hero(render([{ ...acme, lastRun: run({ confirmed: 1 }) }]), "p1")).toContain(">defect in the last run</p>");
  });

  it("leads a project without runs to its plan, and one with a live run to that run", () => {
    const card = hero(render([acme, fresh]), "p2");
    expect(card).toMatch(/>—<\/p><p[^>]*>no run yet<\/p>/);
    expect(card).toContain(">nothing reported yet</p>");
    expect(card).toMatch(/<a href="\/projects\/p2"[^>]*>Open the plan<span class="sr-only"> for Globex<\/span>/);
    for (const status of ["queued", "running"]) {
      expect(hero(render([{ ...acme, lastRun: run({ status }) }]), "p1")).toMatch(/<a href="\/runs\/r9"[^>]*>Follow the run</);
    }
  });

  it("says how the last run ended when it did not complete", () => {
    expect(hero(render([acme]), "p1")).toMatch(/>goals reached<\/p>/);
    expect(hero(render([{ ...acme, lastRun: run({ status: "failed" }) }]), "p1")).toMatch(/>goals reached<span class="text-bad"> · Failed<\/span><\/p>/);
    expect(hero(render([{ ...acme, lastRun: run({ status: "stopped_budget" }) }]), "p1")).toContain('<span class="text-warn"> · Stopped at cap</span>');
    expect(hero(render([{ ...acme, lastRun: run({ status: "queued" }) }]), "p1")).toContain('<span class="text-muted"> · Queued</span>');
  });

  it("names a project that shares its name by its address, on the card and to a screen reader", () => {
    const card = hero(render([{ ...acme, site: "app.acme.test/billing" }]), "p1");
    expect(card).toContain('<span class="sr-only"> for Acme Invoices (app.acme.test/billing)</span>');
    expect(card).toMatch(/>app\.acme\.test\/billing<span aria-hidden="true"> ↗<\/span>/);
  });

  it("lays the project cards out in one, two or four columns by width", () => {
    expect(hero(render([acme]), "p1")).toMatch(/^<article [^>]*class="grid [^"]*\bmd:grid-cols-2\b[^"]*\bwide:grid-cols-\[minmax\(0,1\.5fr\)_repeat\(2,minmax\(120px,0\.5fr\)\)_auto\]/);
  });

  it("lists the recent runs with a way to all of them, and leaves the section out before the first run", () => {
    const html = render([acme], [run(), run({ id: "r8", number: 8 })]);
    expect(html).toContain('<h2 id="recent-runs"');
    expect(html).toMatch(/<a href="\/runs"[^>]*>View all/);
    expect(html.match(/href="\/runs\/r\d"/g)).toEqual(['href="/runs/r9"', 'href="/runs/r9"', 'href="/runs/r8"']);
    expect(html.slice(html.indexOf('id="recent-runs"'))).toContain(">Acme</strong>");
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
