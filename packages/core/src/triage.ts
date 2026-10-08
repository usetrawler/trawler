import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { MAX_LIMIT_REASON, type DefectToGroup, type JobStopReason, type JobUsage, type RunEventInput } from "@usetrawler/protocol";
import { type Budget, failureMessage, stoppedByRun, tallyStep } from "./llm.ts";
import { triagePrompt } from "./prompts.ts";
import { emitSafely, emptyUsage } from "./replay.ts";
import type { SecretScrubber } from "./secrets.ts";

const TRIAGE_OUTPUT_TOKENS = 4000;
const TRIAGE_REPLIES = 2;

const Limit = z.object({ id: z.string(), reason: z.string() });
const Answer = z.object({ limits: z.array(Limit.nullable().catch(null)) });
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

function settleLimits(answer: Answer, defects: DefectToGroup[]): Array<{ key: string; reason: string }> {
  const keys = new Set(defects.map((d) => d.key));
  const chosen = new Map<string, string>();
  for (const limit of answer.limits) {
    const reason = limit?.reason.replace(/\s+/g, " ").trim().slice(0, MAX_LIMIT_REASON);
    if (limit && keys.has(limit.id) && reason && !chosen.has(limit.id)) chosen.set(limit.id, reason);
  }
  return [...chosen].map(([key, reason]) => ({ key, reason }));
}

async function askForTriage(opts: { model: LanguageModel; defects: DefectToGroup[]; setup: string; brief?: string; scrubber: SecretScrubber; budget: Budget }, usage: JobUsage): Promise<{ answer: Answer | null; finishReason: string }> {
  const result = await generateText({
    model: opts.model,
    tools: { report_triage: tool({ description: "Report which reproduced reports only describe the setup of this test.", inputSchema: Answer }) },
    prompt: opts.scrubber.scrub(triagePrompt(opts.defects, opts.setup, opts.brief)),
    maxOutputTokens: TRIAGE_OUTPUT_TOKENS,
    onStepEnd: (step) => void tallyStep(usage, opts.budget, step),
  });
  const call = result.staticToolCalls[0];
  return { answer: call ? call.input : answerInText(result.text), finishReason: result.finishReason };
}

export async function triageFindings(opts: {
  model: LanguageModel;
  modelId: string;
  defects: DefectToGroup[];
  setup: string;
  brief?: string;
  scrubber: SecretScrubber;
  budget: Budget;
  emit: (e: RunEventInput) => void;
}): Promise<{ knownLimits: Array<{ key: string; reason: string }>; usage: JobUsage; stoppedBy: JobStopReason; error?: string }> {
  const emit = (e: RunEventInput) => emitSafely(opts.emit, opts.scrubber.scrub(e));
  const usage = emptyUsage(opts.modelId);
  emit({ type: "job_started", jobId: "triage", kind: "triage" });
  let answer: Answer | null = null;
  let stoppedBy: JobStopReason = "done";
  let error: string | undefined;
  if (opts.budget.exceeded) stoppedBy = "budget";
  else {
    try {
      for (let reply = 0; reply < TRIAGE_REPLIES && answer === null && !opts.budget.exceeded; reply++) {
        ({ answer } = await askForTriage(opts, usage));
      }
      if (answer === null && opts.budget.exceeded) stoppedBy = "budget";
      else if (answer === null) {
        stoppedBy = "error";
        error = `the model gave no triage (${TRIAGE_REPLIES} tries)`;
      }
    } catch (err) {
      stoppedBy = stoppedByRun(err) ? "budget" : "error";
      error = opts.scrubber.scrub(failureMessage(err));
    }
  }
  emit({ type: "job_finished", jobId: "triage", usage, stoppedBy, ...(error ? { error } : {}) });
  return { knownLimits: answer ? settleLimits(answer, opts.defects) : [], usage, stoppedBy, ...(error ? { error } : {}) };
}
