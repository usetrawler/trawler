import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { DefectGroupsSchema, settleGroups, type DefectToGroup, type JobStopReason, type JobUsage, type NotABug, type RunEventInput } from "@usetrawler/protocol";
import { type Budget, failureMessage, stoppedByRun, tallyStep } from "./llm.ts";
import { groupPrompt } from "./prompts.ts";
import { emitSafely, emptyUsage } from "./replay.ts";
import type { SecretScrubber } from "./secrets.ts";

const GROUP_OUTPUT_TOKENS = 8000;
const GROUP_REPLIES = 2;

const NotABugMatch = z.object({ id: z.string(), item: z.number().int() });
const Answer = z.object({
  groups: DefectGroupsSchema,
  notBugs: z.array(NotABugMatch.nullable().catch(null)).optional().catch(undefined),
});
type Answer = z.infer<typeof Answer>;

function answerInText(reply: string): Answer | null {
  const body = reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    const parsed = Answer.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function knownNotBugs(answer: Answer, defects: DefectToGroup[], notBugs: NotABug[]): Array<{ key: string; ref: string }> {
  const keys = new Set(defects.map((d) => d.key));
  const matched = new Map<string, string>();
  for (const match of answer.notBugs ?? []) {
    if (!match) continue;
    const { id, item } = match;
    const ref = notBugs[item - 1]?.ref;
    if (keys.has(id) && ref && !matched.has(id)) matched.set(id, ref);
  }
  return [...matched].map(([key, ref]) => ({ key, ref }));
}

function noGroups(finishReason: string): string {
  const tries = `(${GROUP_REPLIES} tries)`;
  if (finishReason === "length") return `the model ran out of room before it grouped the defects ${tries}`;
  if (finishReason === "content-filter") return `the provider's content filter stopped the model before it grouped the defects ${tries}`;
  return `the model did not group the defects ${tries}`;
}

async function askForGroups(opts: { model: LanguageModel; defects: DefectToGroup[]; notBugs: NotABug[]; scrubber: SecretScrubber; budget: Budget }, usage: JobUsage): Promise<{ answer: Answer | null; finishReason: string }> {
  const result = await generateText({
    model: opts.model,
    tools: { report_groups: tool({ description: opts.notBugs.length > 0 ? "Report which defect reports describe the same defect, and which match a report the team marked not a bug." : "Report which defect reports describe the same defect.", inputSchema: Answer }) },
    prompt: opts.scrubber.scrub(groupPrompt(opts.defects, opts.notBugs)),
    maxOutputTokens: GROUP_OUTPUT_TOKENS,
    onStepEnd: (step) => void tallyStep(usage, opts.budget, step),
  });
  const call = result.staticToolCalls[0];
  return { answer: call ? call.input : answerInText(result.text), finishReason: result.finishReason };
}

export async function groupDefects(opts: {
  model: LanguageModel;
  modelId: string;
  defects: DefectToGroup[];
  notBugs?: NotABug[];
  scrubber: SecretScrubber;
  budget: Budget;
  emit: (e: RunEventInput) => void;
}): Promise<{ groups: string[][] | null; knownNotBugs: Array<{ key: string; ref: string }>; usage: JobUsage; stoppedBy: JobStopReason; error?: string }> {
  const emit = (e: RunEventInput) => emitSafely(opts.emit, opts.scrubber.scrub(e));
  const usage = emptyUsage(opts.modelId);
  emit({ type: "job_started", jobId: "group", kind: "group" });
  let answer: Answer | null = null;
  let stoppedBy: JobStopReason = "done";
  let error: string | undefined;
  if (opts.budget.exceeded) stoppedBy = "budget";
  else {
    try {
      let finishReason = "";
      for (let reply = 0; reply < GROUP_REPLIES && answer === null && !opts.budget.exceeded; reply++) {
        ({ answer, finishReason } = await askForGroups({ ...opts, notBugs: opts.notBugs ?? [] }, usage));
      }
      if (answer === null && opts.budget.exceeded) stoppedBy = "budget";
      else if (answer === null) {
        stoppedBy = "error";
        error = noGroups(finishReason);
      }
    } catch (err) {
      stoppedBy = stoppedByRun(err) ? "budget" : "error";
      error = opts.scrubber.scrub(failureMessage(err));
    }
  }
  const settled = answer && settleGroups(opts.defects.map((d) => d.key), answer.groups);
  emit({ type: "job_finished", jobId: "group", usage, stoppedBy, ...(error ? { error } : {}) });
  return { groups: settled, knownNotBugs: answer ? knownNotBugs(answer, opts.defects, opts.notBugs ?? []) : [], usage, stoppedBy, ...(error ? { error } : {}) };
}
