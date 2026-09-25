import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunLine } from "../../../../projects/overview.ts";
import { RunHistory } from "./run-history.tsx";

const project = { id: "p1", name: "Acme", targetUrl: "https://app.acme.test/" };
const run = (number: number, status: string): RunLine => ({
  id: `run-${number}`, number, status, createdAt: new Date("2026-09-25T18:50:00.000Z"),
  costUsd: 0.35, tokenCap: null, tokensUsed: 0, confirmed: 0, goalsReached: 2, goalsTotal: 6,
});
const render = (runs: RunLine[], olderThan: number | null, paged = false) => renderToStaticMarkup(createElement(RunHistory, { project, runs, olderThan, paged }));

test("every run is listed in the order given, newest first, each leading to its report", () => {
  const html = render([run(12, "succeeded"), run(9, "failed"), run(4, "cancelled")], null);
  const titles = [...html.matchAll(/<a href="\/runs\/(run-\d+)"[^>]*>(Run \d{4})<\/a>/g)].map((m) => `${m[1]} ${m[2]}`);
  expect(titles).toEqual(["run-12 Run 0012", "run-9 Run 0009", "run-4 Run 0004"]);
  expect(html).toContain("Complete");
  expect(html).toContain("Failed");
  expect(html).toContain("Cancelled");
});

test("the page names the project and its runs, and leads back to its plan", () => {
  const html = render([run(1, "succeeded")], null);
  expect(html).toContain("Runs · app.acme.test");
  expect(html).toContain(">Acme</h1>");
  expect(html).toMatch(/<h2 [^>]*>All runs<\/h2>/);
  expect(html).toMatch(/<a href="\/projects\/p1"[^>]*>Back to the plan<\/a>/);
});

test("a longer history leads to its older runs, and an older page back to the newest", () => {
  const first = render([run(12, "succeeded")], 12);
  expect(first).toContain('<nav aria-label="Run history pages"');
  expect(first).toMatch(/<a href="\/projects\/p1\/runs\?before=12"[^>]*>Older runs<\/a>/);
  expect(first).not.toContain("Newest runs");
  const older = render([run(3, "succeeded")], null, true);
  expect(older).toContain('<nav aria-label="Run history pages"');
  expect(older).toMatch(/<a href="\/projects\/p1\/runs"[^>]*>Newest runs<\/a>/);
  expect(older).not.toContain("Older runs");
  expect(render([run(1, "succeeded")], null)).not.toContain("Run history pages");
});

test("a project without runs says where to start one", () => {
  expect(render([], null)).toContain("No runs yet. Start one from the plan.");
  expect(render([], null, true)).toContain("There are no older runs.");
});
