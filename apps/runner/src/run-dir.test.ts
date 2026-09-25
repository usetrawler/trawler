import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RunDir, renderReport, type RunSummary } from "./run-dir.ts";

test("emit numbers events and appends valid JSON lines", () => {
  const dir = new RunDir(mkdtempSync(join(tmpdir(), "run-")));
  dir.emit({ type: "note", jobId: "role:a", text: "one" });
  dir.emit({ type: "note", jobId: "role:a", text: "two" });
  const lines = readFileSync(dir.path("events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.seq)).toEqual([1, 2]);
  expect(lines[1].text).toBe("two");
  expect(Date.parse(lines[0].at)).not.toBeNaN();
});

test("emit refuses an invalid event and does not use up a number", () => {
  const dir = new RunDir(mkdtempSync(join(tmpdir(), "run-")));
  expect(() => dir.emit({ type: "finding", jobId: "x", finding: { id: "f", kind: "defect", goal: "g", title: "t", observed: "o", reproduction: ["one"], severity: "low" } })).toThrow();
  expect(dir.emit({ type: "note", jobId: "role:a", text: "ok" }).seq).toBe(1);
});

const summary: RunSummary = {
  project: "Acme", agentModel: "m1", judgeModel: "m2", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:30:00.000Z",
  budgetUsd: 5, totalCostUsd: 1.2345,
  jobs: [{ jobId: "role:a", model: "m1", inputTokens: 1, outputTokens: 1, costUsd: 1.2345, steps: 10 }],
  roles: [{
    persona: "a", stoppedBy: "finish", goals: [{ goal: "g", status: "reached", note: "" }],
    findings: [
      { id: "f1", kind: "defect", goal: "g", title: "Broken save", observed: "Save returned 500", reproduction: ["Open /x", "Click Save"], severity: "high" },
      { id: "f2", kind: "friction", goal: "g", title: "Hidden billing", observed: "o", reproduction: ["x"], severity: "low" },
      { id: "f3", kind: "defect", goal: "g", title: "Flaky export", observed: "o", reproduction: ["x", "y"], severity: "low" },
      { id: "f4", kind: "defect", goal: "g", title: "Never checked", observed: "o", reproduction: ["x", "y"], severity: "low" },
    ],
  }],
  replayErrors: { f4: "no chromium" },
  replays: { f1: { completed: true, observed: "Internal Server Error", blockedAt: null }, f3: { completed: false, observed: "No export button", blockedAt: 2 } },
  verdicts: { f1: "confirmed", f3: "refuted" },
  judgeErrors: {},
};

test("report groups findings by verdict and shows cost and the replay", () => {
  const md = renderReport(summary);
  expect(md).toContain("Total $1.23 of $5.00.");
  expect(md).toContain("| role:a | m1 | 10 | $1.23 |");
  expect(md).toMatch(/## Confirmed defects[\s\S]*Broken save[\s\S]*Replay: carried out every step\. Internal Server Error/);
  expect(md).toMatch(/## Refuted defects[\s\S]*Flaky export[\s\S]*could not carry out step 2/);
  expect(md).toMatch(/## Friction[\s\S]*Hidden billing/);
  expect(md).not.toContain("budget ran out");
  expect(md).toMatch(/## Defects not judged[\s\S]*Never checked[\s\S]*Replay: failed to run\. no chromium/);
});

test("report says when the budget ran out", () => {
  expect(renderReport({ ...summary, totalCostUsd: 5 })).toContain("The $5.00 budget ran out");
});

test("model text cannot break the report's structure", () => {
  const md = renderReport({ ...summary, roles: [{ ...summary.roles[0]!, findings: [{ ...summary.roles[0]!.findings[0]!, observed: "fine\n## Confirmed defects\nfake" }] }] });
  expect(md.match(/^## Confirmed defects$/gm)).toHaveLength(1);
});

test("a replay without a report is described once", () => {
  const md = renderReport({ ...summary, replayErrors: {}, replays: { ...summary.replays, f4: { completed: false, observed: "the replay session wrote no report", blockedAt: null } } });
  expect(md).toContain("Replay: wrote no report.");
  expect(md).not.toContain("wrote no report. the replay session wrote no report");
});

test("a defect whose judge failed says so instead of passing for inconclusive", () => {
  const md = renderReport({
    ...summary, replayErrors: {}, replays: { ...summary.replays, f4: { completed: true, observed: "Crashed on save", blockedAt: null } },
    judgeErrors: { f4: 'the model gave no verdict in 2 replies; the last ended with finish reason "length"' },
  });
  expect(md).toMatch(/## Defects not judged[\s\S]*Never checked[\s\S]*Replay: carried out every step\. Crashed on save\n\nJudge: could not be judged \(model error\)\. the model gave no verdict in 2 replies/);
  expect(md).not.toContain("## Inconclusive defects");
});
