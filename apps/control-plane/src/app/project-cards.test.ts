import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { ProjectLine } from "../projects/overview.ts";
import { ProjectCards } from "./project-cards.tsx";

const lastRun = {
  id: "run-7", number: 7, status: "stopped_budget", createdAt: new Date("2026-09-25T18:50:00.000Z"),
  costUsd: 2, tokenCap: null, tokensUsed: 0, confirmed: 1, goalsReached: 3, goalsTotal: 6,
};
const projects: ProjectLine[] = [
  { id: "p1", name: "Acme", targetUrl: "https://app.acme.test/start", runs: 3, lastRun },
  { id: "p2", name: "Globex", targetUrl: "https://globex.test/", runs: 0, lastRun: null },
];
const html = renderToStaticMarkup(createElement(ProjectCards, { projects }));
const card = (name: string) => html.split("<li ").find((c) => c.includes(`>${name}</a>`)) ?? "";

test("every project of the workspace is listed with its host", () => {
  expect(card("Acme")).toContain(">app.acme.test</p>");
  expect(card("Acme")).not.toContain("https://app.acme.test/start");
  expect(card("Globex")).toContain(">globex.test</p>");
  expect(html.indexOf(">Acme<")).toBeLessThan(html.indexOf(">Globex<"));
});

test("a project with runs shows its last run and leads to it, to its plan and to all its runs", () => {
  const acme = card("Acme");
  expect(acme).toContain('<a href="/projects/p1" class="underline-offset-4 hover:underline">Acme</a>');
  expect(acme).toMatch(/Last run: <\/span><a href="\/runs\/run-7"[^>]*>Run 0007<\/a>/);
  expect(acme).toContain("Stopped at cap");
  expect(acme).toContain("1 confirmed defect");
  expect(acme).toContain("3 of 6 goals reached");
  expect(acme).toContain("$2.00");
  expect(acme).toMatch(/<a href="\/projects\/p1"[^>]*>Plan and start a run<\/a>/);
  expect(acme).toMatch(/<a href="\/projects\/p1\/runs"[^>]*>All runs · 3<\/a>/);
});

test("a project without runs says so and leads only to its plan", () => {
  const globex = card("Globex");
  expect(globex).toContain("No runs yet.");
  expect(globex).toMatch(/<a href="\/projects\/p2"[^>]*>Open the plan<\/a>/);
  expect(globex).not.toContain("/projects/p2/runs");
  expect(globex).not.toContain("Last run");
});

test("a new project can be started from the list", () => {
  expect(html).toMatch(/<a href="\/new"[^>]*>New project<\/a>/);
});
