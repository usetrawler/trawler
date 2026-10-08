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

test("each row opens its run and shows its number, project, date, status, confirmed defects, goals and cost", () => {
  const [row] = rows(render([line()]));
  expect(row).toContain('href="/runs/0017"');
  expect(row).toContain(">#0017</span>");
  expect(row).toContain(">Acme Invoices</strong>");
  expect(row).toContain('<time dateTime="2026-09-25T12:32:00.000Z">2026-09-25 12:32 UTC</time>');
  expect(row).toMatch(/max-md:hidden text-ok">Complete<\/span>/);
  expect(row).toMatch(/>3<\/strong><small[^>]*>confirmed<span class="sr-only"> defects<\/span><\/small>/);
  expect(row).toMatch(/><span aria-hidden="true">2 \/ 3<\/span><span class="sr-only">2 of 3<\/span><\/strong><small[^>]*>goals<span class="sr-only"> reached<\/span><\/small>/);
  expect(row).toMatch(/>\$3\.08<\/strong><small[^>]*>cost<\/small>/);
});

test("the status uses the run page's words, coloured by how the run ended", () => {
  const statuses = rows(render([
    line({ id: "a", status: "stopped_budget" }), line({ id: "b", status: "failed" }), line({ id: "c", status: "running" }), line({ id: "d", status: "cancelled" }), line({ id: "e", status: "queued" }),
  ])).map((row) => row.match(/class="font-mono text-\[10px\] max-md:hidden ([^"]*)">([^<]*)</)?.slice(1));
  expect(statuses).toEqual([["text-warn", "Stopped at cap"], ["text-bad", "Failed"], ["text-info", "Live"], ["text-muted", "Cancelled"], ["text-muted", "Queued"]]);
});

test("on a phone, where the status column is hidden, the status follows the date", () => {
  const [row] = rows(render([line({ status: "failed" })]));
  expect(row).toMatch(/<\/time><span class="md:hidden text-bad"> · Failed<\/span><\/small>/);
});

test("a run capped by tokens shows the tokens it used instead of a cost", () => {
  const [row] = rows(render([line({ tokenCap: 1_000_000, tokensUsed: 1_234_567 })]));
  expect(row).toMatch(/>1\.23M<\/strong><small[^>]*>tokens<\/small>/);
  expect(row).not.toContain("$");
});

test("a project that shares its name with another shows its product's host", () => {
  const [row] = rows(render([line({ projectName: "Shop", projectSite: "staging.shop.test" })]));
  expect(row).toContain('>Shop<span class="font-normal text-muted"> · staging.shop.test</span></strong>');
  expect(rows(render([line()]))[0]).not.toContain("font-normal text-muted");
});

test("inside one project the date leads each row instead of the project's name", () => {
  const [row] = rows(render([line({ status: "stopped_budget" })], false));
  expect(row).not.toContain("Acme Invoices");
  expect(row).toMatch(/<strong class="block truncate"><time dateTime="2026-09-25T12:32:00\.000Z">[^<]*<\/time><\/strong><small class="[^"]*md:hidden text-warn">Stopped at cap<\/small>/);
});

test("the rows keep the order they are given in, newest first from the query", () => {
  const html = render([line({ id: "new", number: 18 }), line({ id: "old", number: 17 })]);
  expect(rows(html).map((row) => row.match(/href="\/runs\/([^"]*)"/)?.[1])).toEqual(["0018", "0017"]);
});

test("a run whose every replay failed shows no count of confirmed defects, but that they were not checked", () => {
  const [row] = rows(render([line({ confirmed: 0, unchecked: true })]));
  expect(row).toMatch(/><span aria-hidden="true">—<\/span><\/strong><small[^>]*>not checked<span class="sr-only">: every replay failed<\/span><\/small>/);
  expect(row).toMatch(/md:hidden text-ok"> · Complete · not checked<\/span>/);
  expect(row).toMatch(/max-md:hidden text-ok"><span class="wide:hidden">Complete · not checked<\/span><span class="max-wide:hidden">Complete<\/span><\/span>/);
  expect(row).not.toContain(">confirmed<");
});

const narrowSummary = (html: string) => html.match(/<small class="mt-1 block text-\[10px\] text-muted wide:hidden">([^<]*)<\/small>/)?.[1];

test("narrow run rows keep their results and spend below the date in both histories", () => {
  for (const project of [true, false]) {
    expect(narrowSummary(render([line()], project))).toBe("3 confirmed · 2/3 goals · $3.08");
    expect(narrowSummary(render([line({ confirmed: 0, goalsReached: 0, costUsd: 0 })], project))).toBe("0 confirmed · 0/3 goals · $0.00");
  }
});

test("the narrow summary preserves unchecked defects and token-priced spend", () => {
  expect(narrowSummary(render([line({ confirmed: 0, unchecked: true })]))).toBe("not checked · 2/3 goals · $3.08");
  expect(narrowSummary(render([line({ tokenCap: 1_000_000, tokensUsed: 1_234_567 })]))).toBe("3 confirmed · 2/3 goals · 1.23M tokens");
});

test("a run names its plan after the project, or after its date inside a project, only when the line carries one", () => {
  const [named] = rows(render([line({ planName: "Invitations" })]));
  expect(named).toContain("Invitations</span></strong>");
  const [inProject] = rows(render([line({ planName: "Invitations" })], false));
  expect(inProject).toMatch(/<time[^>]*>[^<]*<\/time><span class="font-normal text-muted"> · Invitations<\/span>/);
  expect(rows(render([line()])[0] ? render([line()]) : "")[0]).not.toContain(" · Invitations");
});

test("a run started over MCP names the assistant and the person on its row, and any other run says nothing of it", () => {
  const via = { kind: "mcp" as const, client: "Claude Code", clientHost: "claude.ai", person: "Ana Lopez" };
  const [over] = rows(render([line({ startedVia: via, origin: "mcp" })]));
  expect(over).toContain("MCP · Claude Code (claude.ai) · Ana Lopez</small>");
  expect(rows(render([line()])).join("")).not.toContain("MCP");
});
