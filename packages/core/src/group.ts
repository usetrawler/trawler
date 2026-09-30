import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { DefectGroupsSchema, settleGroups, type DefectToGroup, type JobStopReason, type JobUsage, type RunEventInput } from "@usetrawler/protocol";
import { type Budget, failureMessage, stoppedByRun, tallyStep } from "./llm.ts";
import { groupPrompt } from "./prompts.ts";
import { emitSafely, emptyUsage } from "./replay.ts";
import type { SecretScrubber } from "./secrets.ts";

const GROUP_OUTPUT_TOKENS = 8000;
const GROUP_REPLIES = 2;

const Answer = z.object({ groups: DefectGroupsSchema });

function groupsInText(reply: string): string[][] | null {
  const body = reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    const parsed = Answer.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.groups : null;
  } catch {
    return null;
  }
}

function noGroups(finishReason: string): string {
  const tries = `(${GROUP_REPLIES} tries)`;
  if (finishReason === "length") return `the model ran out of room before it grouped the defects ${tries}`;
  if (finishReason === "content-filter") return `the provider's content filter stopped the model before it grouped the defects ${tries}`;
  return `the model did not group the defects ${tries}`;
}

async function askForGroups(opts: { model: LanguageModel; defects: DefectToGroup[]; scrubber: SecretScrubber; budget: Budget }, usage: JobUsage): Promise<{ groups: string[][] | null; finishReason: string }> {
  const result = await generateText({
    model: opts.model,
    tools: { report_groups: tool({ description: "Report which defect reports describe the same defect.", inputSchema: Answer }) },
    prompt: opts.scrubber.scrub(groupPrompt(opts.defects)),
    maxOutputTokens: GROUP_OUTPUT_TOKENS,
    onStepEnd: (step) => void tallyStep(usage, opts.budget, step),
  });
  const call = result.staticToolCalls[0];
  return { groups: call ? call.input.groups : groupsInText(result.text), finishReason: result.finishReason };
}

export async function groupDefects(opts: {
  model: LanguageModel;
  modelId: string;
  defects: DefectToGroup[];
  scrubber: SecretScrubber;
  budget: Budget;
  emit: (e: RunEventInput) => void;
}): Promise<{ groups: string[][] | null; usage: JobUsage; stoppedBy: JobStopReason; error?: string }> {
  const emit = (e: RunEventInput) => emitSafely(opts.emit, opts.scrubber.scrub(e));
  const usage = emptyUsage(opts.modelId);
  emit({ type: "job_started", jobId: "group", kind: "group" });
  let groups: string[][] | null = null;
  let stoppedBy: JobStopReason = "done";
  let error: string | undefined;
  if (opts.budget.exceeded) stoppedBy = "budget";
  else {
    try {
      let finishReason = "";
      for (let reply = 0; reply < GROUP_REPLIES && groups === null && !opts.budget.exceeded; reply++) {
        ({ groups, finishReason } = await askForGroups(opts, usage));
      }
      if (groups === null && opts.budget.exceeded) stoppedBy = "budget";
      else if (groups === null) {
        stoppedBy = "error";
        error = noGroups(finishReason);
      }
    } catch (err) {
      stoppedBy = stoppedByRun(err) ? "budget" : "error";
      error = opts.scrubber.scrub(failureMessage(err));
    }
  }
  const settled = groups && settleGroups(opts.defects.map((d) => d.key), groups);
  emit({ type: "job_finished", jobId: "group", usage, stoppedBy, ...(error ? { error } : {}) });
  return { groups: settled, usage, stoppedBy, ...(error ? { error } : {}) };
}
