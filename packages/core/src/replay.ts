import { generateText, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { VerdictSchema, type Finding, type JobStopReason, type JobUsage, type ProjectConfig, type ReplayObservation, type RunEventInput, type Verdict } from "@usetrawler/protocol";
import { browserQueue, runAgentLoop } from "./agent-loop.ts";
import { type Budget, failureMessage, stoppedByRun, tallyStep } from "./llm.ts";
import { judgePrompt, replayPrompt } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { newSessionState, sessionTools, type FillField } from "./session-tools.ts";

const NO_REPORT: ReplayObservation = { completed: false, observed: "the replay session wrote no report", blockedAt: null };
const NUDGE = "Every turn must call a tool; plain text does nothing. Carry on with the steps, and call report_replay when you are done or blocked.";

const MAX_OBSERVED_CODE_POINTS = 4000;
const JUDGE_OUTPUT_TOKENS = 8000;
const JUDGE_REPLIES = 2;

const isNoReport = (o: ReplayObservation) => !o.completed && o.blockedAt === null;

function onlyDefects(finding: Finding, what: string) {
  if (finding.kind !== "defect") throw new RangeError(`only defects are ${what}, ${finding.id} is ${finding.kind}`);
}

function emitSafely(emit: (e: RunEventInput) => void, e: RunEventInput) {
  try {
    emit(e);
  } catch {
    return;
  }
}

const emptyUsage = (model: string): JobUsage => ({ model, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 });

export async function runReplay(opts: {
  model: LanguageModel;
  modelId: string;
  finding: Finding;
  project: ProjectConfig;
  accountRef?: string;
  browserTools: ToolSet;
  fillField: FillField;
  scrubber: SecretScrubber;
  budget: Budget;
  maxSteps: number;
  emit: (e: RunEventInput) => void;
}): Promise<{ observation: ReplayObservation; usage: JobUsage }> {
  onlyDefects(opts.finding, "replayed");
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) throw new RangeError(`maxSteps must be a positive integer, got ${opts.maxSteps}`);
  const jobId = `replay:${opts.finding.id}`;
  const emit = (e: RunEventInput) => opts.emit(opts.scrubber.scrub(e));
  const stepCount = opts.finding.reproduction.length;
  const queue = browserQueue(opts.browserTools, opts.fillField);
  const { sign_in } = sessionTools({
    state: newSessionState([]),
    accounts: opts.project.accounts.filter((a) => a.ref === opts.accountRef),
    emit, jobId,
    fillField: queue.fillField,
    scrubber: opts.scrubber,
    newId: () => "unused",
  });
  let report: ReplayObservation | null = null;
  const report_replay = tool({
    description: "Report what you saw while following the steps. completed is true only if you carried out every step; otherwise give the number of the step you could not do as blockedAt.",
    inputSchema: z.object({ completed: z.boolean().nullish(), observed: z.string().nullish(), blockedAt: z.number().nullish() }),
    execute: async ({ completed, observed, blockedAt }) => queue.run(async () => {
      if (report) return "rejected: the replay is already reported";
      if (typeof completed !== "boolean") return "rejected: completed: say whether you carried out every step";
      if (!observed?.trim()) return "rejected: observed: describe what you saw";
      if (completed && blockedAt != null) return "rejected: blockedAt: a completed replay was not blocked; leave blockedAt empty";
      if (!completed && (blockedAt == null || !Number.isInteger(blockedAt) || blockedAt < 1 || blockedAt > stepCount)) {
        return `rejected: blockedAt: give the number of the step you could not do; there are only ${stepCount} steps`;
      }
      report = { completed, observed: Array.from(opts.scrubber.scrub(observed.trim())).slice(0, MAX_OBSERVED_CODE_POINTS).join(""), blockedAt: completed ? null : blockedAt! };
      return "reported";
    }),
  });
  const instructions = replayPrompt({ targetUrl: opts.project.targetUrl, steps: opts.finding.reproduction, accountRef: opts.accountRef });
  const usage = emptyUsage(opts.modelId);

  emit({ type: "job_started", jobId, kind: "replay" });
  const outcome = await runAgentLoop({
    model: opts.model,
    tools: { ...queue.tools, sign_in, report_replay },
    instructions: () => `${instructions}\n\nTurn ${usage.steps + 1} of ${opts.maxSteps}.`,
    nudge: NUDGE,
    scrubber: opts.scrubber,
    budget: opts.budget,
    maxSteps: opts.maxSteps,
    usage,
    finished: () => report !== null,
    crashed: queue.crashed,
    onStep: (step, costUsd) => emit({ type: "step", jobId, step: usage.steps, tool: step.toolCalls[0]?.toolName ?? null, costUsd }),
    largeResultChars: 4000,
  });
  const observation: ReplayObservation = report ?? NO_REPORT;
  const stoppedBy: JobStopReason = outcome.stoppedBy === "finish" ? "report" : outcome.stoppedBy;
  emitSafely(emit, { type: "job_finished", jobId, usage, stoppedBy, ...(outcome.error ? { error: outcome.error } : {}) });
  return { observation, usage };
}

const Answer = z.object({ verdict: VerdictSchema });

function noVerdict(finishReason: string): string {
  const tries = `(${JUDGE_REPLIES} tries)`;
  if (finishReason === "length") return `the model ran out of room before it gave a verdict ${tries}`;
  if (finishReason === "content-filter") return `the provider's content filter stopped the model before it gave a verdict ${tries}`;
  return `the model gave no verdict ${tries}`;
}

function verdictInText(reply: string): Verdict | null {
  const body = reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  try {
    const parsed = Answer.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.verdict : null;
  } catch {
    return null;
  }
}

async function askJudge(opts: { model: LanguageModel; finding: Finding; observation: ReplayObservation; scrubber: SecretScrubber; budget: Budget }, usage: JobUsage): Promise<{ verdict: Verdict | null; finishReason: string }> {
  const result = await generateText({
    model: opts.model,
    tools: { report_verdict: tool({ description: "Give your verdict on the claim.", inputSchema: Answer }) },
    prompt: opts.scrubber.scrub(judgePrompt(opts.finding, opts.observation)),
    maxOutputTokens: JUDGE_OUTPUT_TOKENS,
    onStepEnd: (step) => void tallyStep(usage, opts.budget, step),
  });
  const call = result.staticToolCalls[0];
  return { verdict: call ? call.input.verdict : verdictInText(result.text), finishReason: result.finishReason };
}

export async function judge(opts: {
  model: LanguageModel;
  modelId: string;
  finding: Finding;
  observation: ReplayObservation;
  scrubber: SecretScrubber;
  budget: Budget;
  emit: (e: RunEventInput) => void;
}): Promise<{ verdict: Verdict | null; usage: JobUsage; error?: string }> {
  onlyDefects(opts.finding, "judged");
  const jobId = `judge:${opts.finding.id}`;
  const emit = (e: RunEventInput) => emitSafely(opts.emit, opts.scrubber.scrub(e));
  const usage = emptyUsage(opts.modelId);
  emit({ type: "job_started", jobId, kind: "judge" });
  let verdict: Verdict | null = null;
  let stoppedBy: JobStopReason = "done";
  let error: string | undefined;
  if (isNoReport(opts.observation)) stoppedBy = "no_report";
  else if (opts.budget.exceeded) stoppedBy = "budget";
  else {
    try {
      let finishReason = "";
      for (let reply = 0; reply < JUDGE_REPLIES && verdict === null && !opts.budget.exceeded; reply++) {
        ({ verdict, finishReason } = await askJudge(opts, usage));
      }
      if (verdict === null && opts.budget.exceeded) stoppedBy = "budget";
      else if (verdict === null) {
        stoppedBy = "error";
        error = noVerdict(finishReason);
      }
    } catch (err) {
      stoppedBy = stoppedByRun(err) ? "budget" : "error";
      error = opts.scrubber.scrub(failureMessage(err));
    }
  }
  if (verdict) emit({ type: "verdict", jobId, findingId: opts.finding.id, verdict, observed: opts.observation.observed });
  emit({ type: "job_finished", jobId, usage, stoppedBy, ...(error ? { error } : {}) });
  return { verdict, usage, ...(error ? { error } : {}) };
}
