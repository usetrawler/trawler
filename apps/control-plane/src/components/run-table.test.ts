import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunLine } from "../projects/overview.ts";
import { RunTable } from "./run-table.tsx";

const line = (over: Partial<RunLine> = {}): RunLine => ({
  startedVia: null, origin: "app",
  id: "r1", number: 17, status: "succeeded", createdAt: new Date("2026-09-25T12:32:00Z"), costUsd: 3.08, tokenCap: null, tokensUsed: 0,
  confirmed: 3, unchecked: false, goalsReached: 2, goalsTotal: 3, projectId: "p1", projectName: "Acme Invoices", projectSite: null, planName: null, ...over,
});
const render = (runs: RunLine[], project = true) => renderToStaticMarkup(createElement(RunTable, { runs, project }));
const rows = (html: string) => html.match(/<li[^>]*>.*?<\/li>/g) ?? [];
const words = (row: string) => row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("the list separates the run, plan, status and goals, with an accessible plan label on narrow layouts", () => {
  const html = render([line({ savedPlan: { name: "PR #24 v5", title: "Filter invoices by cycle" } })]);
  expect(html).toMatch(/>Run<\/span><span>Plan<\/span><span>Status<\/span><span>Goals<\/span>/);
  const [row] = rows(html);
  expect(row).toContain('href="/runs/0017"');
  expect(row).toContain('<time dateTime="2026-09-25T12:32:00.000Z">2026-09-25 12:32 UTC</time>');
  expect(words(row!)).toContain("#0017 Acme Invoices 2026-09-25 12:32 UTC Plan Filter invoices by cycle PR #24 v5 Complete 3 confirmed defects Goals reached 2 / 3 $3.08");
});

test("a saved plan is shown even if it is the only one, including inside the project, and an absent plan is labelled", () => {
  for (const project of [true, false]) {
    const [row] = rows(render([line({ savedPlan: { name: "Invitations", title: null } })], project));
    expect(words(row!)).toContain("Plan Invitations");
    expect(row!.includes("Acme Invoices")).toBe(project);
  }
  expect(words(rows(render([line()]))[0]!)).toContain("Plan No linked plan");
});

test("the rows use the run page's statuses and keep their order", () => {
  const states = ["stopped_budget", "failed", "running", "cancelled", "queued"];
  const html = render(states.map((status, index) => line({ id: status, number: 17 - index, status })));
  expect(rows(html).map((row) => row.match(/href="\/runs\/([^"]*)"/)?.[1])).toEqual(["0017", "0016", "0015", "0014", "0013"]);
  expect(rows(html).map((row) => row.match(/font-semibold (text-[^"]+)">([^<]*)<\/strong>/)?.slice(1))).toEqual([
    ["text-warn", "Stopped at cap"], ["text-bad", "Failed"], ["text-info", "Live"], ["text-muted", "Cancelled"], ["text-muted", "Queued"],
  ]);
});

test("unchecked findings remain distinct from zero, and a token cap displays usage in tokens", () => {
  const [row] = rows(render([line({ confirmed: 0, unchecked: true, tokenCap: 2_000_000, tokensUsed: 1_234_567 })]));
  expect(words(row!)).toContain("Not checked : every replay failed Goals reached 2 / 3 1.23M tokens");
  expect(row).not.toContain("0 confirmed");
  expect(row).not.toContain("$");
});

test("a duplicate project name includes its address, and MCP runs name the assistant and person", () => {
  const startedVia = { kind: "mcp" as const, client: "Claude Code", clientHost: "claude.ai", person: "Ana Lopez" };
  const [row] = rows(render([line({ projectName: "Shop", projectSite: "staging.shop.test", startedVia })]));
  expect(words(row!)).toContain("Shop · staging.shop.test");
  expect(words(row!)).toContain("MCP · Claude Code (claude.ai) · Ana Lopez");
  expect(render([line()])).not.toContain("MCP");
});
