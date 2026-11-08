import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunLine } from "../../projects/overview.ts";
import type { OpenFinding } from "../../projects/project-home.ts";
import { FindingsView } from "./findings-view.tsx";

const projects = [{ id: "p1", name: "Recurro", address: "localhost:8080" }, { id: "p2", name: "TodoMVC", address: "demo.playwright.dev" }, { id: "p3", name: "Swag Labs", address: "saucedemo.com" }];
const finding = (projectId: string, key: string, patch: Partial<OpenFinding> = {}): OpenFinding => ({ projectId, key, title: `Title ${key}`, severity: "high", person: "Maya", source: "PR #21", runNumber: 292, reportedAt: new Date("2026-11-07T10:00:00Z"), ...patch });
const live = { id: "r300", number: 300, status: "running", createdAt: new Date(), costUsd: 0, tokenCap: null, tokensUsed: 0, confirmed: 0, unchecked: false, goalsReached: 0, goalsTotal: 3, projectId: "p1", projectName: "Recurro", projectSite: null, planName: null, savedPlan: { name: "PR #24 v16", title: null }, startedVia: null, origin: "api" } satisfies RunLine;
const render = (findings: OpenFinding[], going: RunLine[] = []) => renderToStaticMarkup(createElement(FindingsView, { projects, findings, going }));

test("findings are grouped by project in the panel's order, each group linking to its project and counting its findings", () => {
  const html = render([finding("p2", "alex:f1"), finding("p1", "maya:f1"), finding("p1", "devon:f1", { severity: "low", source: "PR #22", runNumber: 293, person: "Devon" })]);
  expect(html).toContain(">Findings</h1>");
  expect(html).toContain("Confirmed defects from the latest run of each pull request and plan. Mark one not a bug and it leaves this list.");
  const groups = [...html.matchAll(/<h2 id="findings-(p\d)"[^>]*><a href="\/projects\/(p\d)\/overview"[^>]*>([^<]+)<\/a><span[^>]*>(\d+)<\/span><\/h2>/g)].map((m) => [m[1], m[3], m[4]]);
  expect(groups).toEqual([["p1", "Recurro", "2"], ["p2", "TodoMVC", "1"]]);
  expect(html).toContain('href="/runs/0293#finding-devon%3Af1"');
  expect(html).toContain("The other project has no confirmed defects in its latest runs.");
});

test("two projects with the same name are told apart by their address", () => {
  const twins = [{ id: "a", name: "Shop", address: "shop.test/eu" }, { id: "b", name: "Shop", address: "shop.test/us" }];
  const html = renderToStaticMarkup(createElement(FindingsView, { projects: twins, findings: [finding("a", "k1"), finding("b", "k2")], going: [] }));
  expect(html).toMatch(/>Shop<\/a><span[^>]*>shop\.test\/eu<\/span>/);
  expect(html).toMatch(/>Shop<\/a><span[^>]*>shop\.test\/us<\/span>/);
  expect(render([finding("p1", "k")])).not.toMatch(/>Recurro<\/a><span[^>]*>localhost/);
});

test("with nothing open the page says so, and runs that are going show with their project", () => {
  const html = render([], [live]);
  expect(html).toContain(">No confirmed defects are open.</p>");
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("other project");
  expect(html).toMatch(/>Recurro · Run 0300 is running<\/span><span[^>]*>PR #24 v16<\/span><a href="\/runs\/0300"[^>]*>Watch/);
});
