import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ProjectHead, type ProjectTab } from "./project-head.tsx";

const project = { id: "p1", name: "Acme Invoices", targetUrl: "https://app.acme.test/billing" };
const running = { paused: false, liveRun: null };
const counts = { runs: 3, pullRequests: 2 };
const render = (tab: ProjectTab, runState = running, target = project) => renderToStaticMarkup(createElement(ProjectHead, { project: target, tab, counts, runState }));
const tabs = (html: string) => [...(html.match(/<nav aria-label="Project">.*?<\/nav>/)?.[0] ?? "").matchAll(/<a href="([^"]*)"( aria-current="page")?[^>]*>([^<]*)/g)].map((m) => [m[3], m[1], Boolean(m[2])]);

test("a project page names the project and its product, which opens in a new tab", () => {
  const html = render("plan");
  expect(html).toContain(">Acme Invoices</h1>");
  expect(html).toMatch(/<a href="https:\/\/app\.acme\.test\/billing" target="_blank" rel="noreferrer"[^>]*>app\.acme\.test<span aria-hidden="true"> ↗<\/span><span class="sr-only normal-case"> \(opens in a new tab\)<\/span><\/a>/);
  expect(html).not.toContain("Runs only from CI");
});

test("a product on a private network says its runs only come from CI", () => {
  expect(render("home", running, { ...project, targetUrl: "http://localhost:8080" })).toContain(" · Runs only from CI (private network)");
});

test("the project tabs are Home, Plan, Pull requests, Runs and Product", () => {
  expect(tabs(render("plan"))).toEqual([
    ["Home", "/projects/p1/overview", false], ["Plan", "/projects/p1", true], ["Pull requests", "/projects/p1/pull-requests", false], ["Runs", "/projects/p1/runs", false], ["Product", "/projects/p1/product", false],
  ]);
  expect(tabs(render("pull-requests")).filter((t) => t[2]).map((t) => t[0])).toEqual(["Pull requests"]);
  expect(tabs(render("product")).filter((t) => t[2]).map((t) => t[0])).toEqual(["Product"]);
});

test("the open tab is set apart by weight and a bar, not only colour, and Pull requests and Runs carry their numbers", () => {
  const html = render("runs");
  expect(html).toMatch(/aria-current="page" class="[^"]*\bborder-ink\b[^"]*\bfont-medium\b[^"]*">Runs<span[^>]*>3<\/span><\/a>/);
  expect(html).toMatch(/>Pull requests<span[^>]*>2<\/span><\/a>/);
  expect(html).toMatch(/<a href="\/projects\/p1" class="[^"]*\bborder-transparent\b[^"]*">Plan<\/a>/);
  expect(html).not.toMatch(/<a href="\/projects\/p1" class="[^"]*\bfont-medium\b/);
});

test("a project that shares its name shows the address the panel gives it, underlined as a link", () => {
  const html = renderToStaticMarkup(createElement(ProjectHead, { project, address: "app.acme.test/billing", tab: "plan", counts, runState: running }));
  expect(html).toMatch(/<a href="https:\/\/app\.acme\.test\/billing" target="_blank" rel="noreferrer" class="[^"]*underline [^"]*">app\.acme\.test\/billing<span aria-hidden="true"> ↗<\/span>/);
});

test("a new run opens the start page for this project", () => {
  expect(render("runs")).toMatch(/<a href="\/runs\/new\?project=p1"[^>]*>New run<\/a>/);
});

test("runs can be paused from the head, and a paused project says so above everything and offers Resume runs instead of a new run", () => {
  const open = render("plan");
  expect(open).toMatch(/<button type="button"[^>]*>Pause runs<\/button>/);
  expect(open).toContain(">New run<");
  expect(open).not.toContain("are paused");
  const paused = render("home", { paused: true, liveRun: null });
  expect(paused).toMatch(/^<div[^>]*><p role="status"[^>]*><span[^>]*>Runs on Acme Invoices are paused\.<\/span><span[^>]*>CI jobs and New run are refused until you resume them\.<\/span><\/p>/);
  expect(paused).toMatch(/<button type="button"[^>]*>Resume runs<\/button>/);
  expect(paused).not.toContain("New run<");
  expect(paused).not.toContain("Pause runs");
});
