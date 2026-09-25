import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import type { RunSummary } from "../../../runs/runs.ts";
import { runView } from "../../../runs/report.ts";

vi.mock("./actions.ts", () => ({ cancelRunAction: async () => true, judgeAgainAction: async () => ({}), runAgainAction: async () => ({}) }));

const { RunLive } = await import("./run-live.tsx");

const summary = (status: string): RunSummary => ({
  id: "run-1", number: 7, status, projectId: "project-1", costUsd: 0.2, budgetUsd: 2, agentModel: "deepseek/deepseek-v4.1-flash", judgeModel: "deepseek/deepseek-v4.1-flash",
  provider: "openrouter", tokenCap: null, tokensUsed: 0, createdAt: new Date(), startedAt: new Date(), finishedAt: null,
  jobs: [], findings: [], goals: [], target: "https://app.acme.test/", personas: [], goalTexts: [], activity: [],
});
const render = (status: string) => {
  const run = summary(status);
  return renderToStaticMarkup(createElement(RunLive, { initial: JSON.parse(JSON.stringify({ run, view: runView(run) })) }));
};

test("a finished run offers Run again beside its heading, and Start another run at the end; a live run offers neither", () => {
  for (const status of ["succeeded", "stopped_budget", "failed", "cancelled"]) {
    const html = render(status);
    const head = html.slice(0, html.indexOf('<div class="grid gap-3'));
    expect(head).toMatch(/<\/h1>[\s\S]*<button type="button"[^>]*>Run again<span aria-hidden="true">→<\/span><\/button>/);
    expect(html).toContain(">Start another run</a>");
  }
  for (const status of ["queued", "running"]) {
    const html = render(status);
    expect(html).toContain(">Back to the plan</a>");
    expect(html).not.toContain("Run again");
  }
});
