import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ProjectHead } from "./project-head.tsx";

const project = { id: "p1", name: "Acme Invoices", targetUrl: "https://app.acme.test/billing" };
const running = { paused: false, liveRun: null };
const render = (tab: "plan" | "runs", runs = 3, runState = running) => renderToStaticMarkup(createElement(ProjectHead, { project, tab, runs, runState }));
const tabs = (html: string) => [...(html.match(/<nav aria-label="Project">.*?<\/nav>/)?.[0] ?? "").matchAll(/<a href="([^"]*)"( aria-current="page")?[^>]*>([^<]*)/g)].map((m) => [m[3], m[1], Boolean(m[2])]);

test("a project page names the project and its product, which opens in a new tab", () => {
  const html = render("plan");
  expect(html).toContain(">Acme Invoices</h1>");
  expect(html).toMatch(/>Project · <a href="https:\/\/app\.acme\.test\/billing" target="_blank" rel="noreferrer"[^>]*>app\.acme\.test<span aria-hidden="true"> ↗<\/span><span class="sr-only normal-case"> \(opens in a new tab\)<\/span><\/a>/);
});

test("the Plan and Runs tabs lead to the plan and the project's runs, and mark the one open", () => {
  expect(tabs(render("plan"))).toEqual([["Plan", "/projects/p1", true], ["Runs", "/projects/p1/runs", false]]);
  expect(tabs(render("runs"))).toEqual([["Plan", "/projects/p1", false], ["Runs", "/projects/p1/runs", true]]);
});

test("the open tab is set apart by weight and a bar, not only colour, and Runs carries the number of runs", () => {
  const html = render("runs", 12);
  expect(html).toMatch(/aria-current="page" class="[^"]*\bborder-action\b[^"]*\bfont-semibold\b[^"]*">Runs<span[^>]*>12<\/span><\/a>/);
  expect(html).toMatch(/<a href="\/projects\/p1" class="[^"]*\bborder-transparent\b[^"]*">Plan<\/a>/);
  expect(html).not.toMatch(/<a href="\/projects\/p1" class="[^"]*\bfont-semibold\b/);
});

test("a project that shares its name shows the address the panel gives it, underlined as a link", () => {
  const html = renderToStaticMarkup(createElement(ProjectHead, { project, address: "app.acme.test/billing", tab: "plan", runs: 1, runState: running }));
  expect(html).toMatch(/<a href="https:\/\/app\.acme\.test\/billing" target="_blank" rel="noreferrer" class="underline [^"]*">app\.acme\.test\/billing<span aria-hidden="true"> ↗<\/span>/);
});

test("a new run starts at the plan's Start section", () => {
  expect(render("runs")).toMatch(/<a href="\/projects\/p1#start"[^>]*>New run<span aria-hidden="true">→<\/span><\/a>/);
});

test("runs can be paused from the head, and a paused project offers Resume runs instead of a new run", () => {
  const open = render("plan");
  expect(open).toMatch(/<button type="button"[^>]*>Pause runs<\/button>/);
  expect(open).toContain(">New run<");
  const paused = render("plan", 3, { paused: true, liveRun: null });
  expect(paused).toContain(">Runs paused</p>");
  expect(paused).toMatch(/<button type="button"[^>]*>Resume runs<\/button>/);
  expect(paused).not.toContain("New run");
  expect(paused).not.toContain("Pause runs");
});
