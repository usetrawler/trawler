import { describe, expect, test } from "vitest";
import type { DefectToGroup } from "@usetrawler/protocol";
import { Budget } from "./llm.ts";
import { triagePrompt } from "./prompts.ts";
import { SecretScrubber } from "./secrets.ts";
import { scriptedModel, text, toolCall } from "./testing.ts";
import { triageFindings } from "./triage.ts";

const defects: DefectToGroup[] = [
  { key: "f1", person: "Maya", goal: "Get in", title: "No way to sign up", observed: "Only a sign-in form.", reproduction: ["Open /", "Look for a sign-up link"] },
  { key: "f2", person: "Kuba", goal: "Ask to cancel", title: "Approved charge still counts", observed: "The total did not change.", reproduction: ["Approve the request", "Open the summary"] },
];
const setup = "There is no self sign-up; accounts come from an invitation. No mail server.";
const run = (model: ReturnType<typeof scriptedModel>, over: Partial<Parameters<typeof triageFindings>[0]> = {}) =>
  triageFindings({ model, modelId: "m", defects, setup, scrubber: new SecretScrubber(), budget: new Budget(1), emit: () => {}, ...over });

describe("triageFindings", () => {
  test("sets aside only reports it names that exist, once each, with a short reason", async () => {
    const answer = toolCall("report_triage", { limits: [{ id: "f1", reason: "  No self sign-up here.  " }, { id: "f1", reason: "again" }, { id: "zz", reason: "unknown" }] });
    const result = await run(scriptedModel([answer]));
    expect(result.knownLimits).toEqual([{ key: "f1", reason: "No self sign-up here." }]);
    expect(result.stoppedBy).toBe("done");
  });

  test("reads an answer given as text, and gives up after two empty replies", async () => {
    expect((await run(scriptedModel([text('{"limits": [{"id": "f1", "reason": "No sign-up."}]}')]))).knownLimits).toEqual([{ key: "f1", reason: "No sign-up." }]);
    const empty = await run(scriptedModel([text("no idea"), text("still none")]));
    expect(empty).toMatchObject({ knownLimits: [], stoppedBy: "error", error: "the model gave no triage (2 tries)" });
  });

  test("does not ask the model once the budget is spent", async () => {
    const model = scriptedModel([]);
    const budget = new Budget(1);
    budget.add(1);
    expect(await run(model, { budget })).toMatchObject({ knownLimits: [], stoppedBy: "budget" });
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

test("the triage prompt fences the setup, the brief and the reports as data, and keeps a report when unsure", () => {
  const prompt = triagePrompt(defects, setup, "An approved charge leaves the monthly total.");
  const tag = /<setup-([a-z0-9]+)>/.exec(prompt)![1]!;
  expect(prompt).toContain(`<setup-${tag}>\n${setup}\n</setup-${tag}>`);
  expect(prompt).toContain(`<brief-${tag}>`);
  expect(prompt).toContain("id: f2");
  expect(prompt).toMatch(/If you are not sure, keep the report/);
  expect(triagePrompt(defects, setup)).not.toContain("<brief-");
});
