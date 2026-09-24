import type { LanguageModel, ToolSet } from "ai";
import type { JobUsage, Persona, ProjectConfig, RoleResult, RunEventInput } from "@usetrawler/protocol";
import { browserQueue, runAgentLoop } from "./agent-loop.ts";
import type { Budget } from "./llm.ts";
import { rolePrompt, sessionStatus } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { newSessionState, sessionTools, type FillField } from "./session-tools.ts";

const NUDGE = "Every turn must call a tool; plain text does nothing. Continue with the goals, and call finish once every goal has a status.";

export async function runRoleSession(opts: {
  model: LanguageModel;
  modelId: string;
  persona: Persona;
  project: ProjectConfig;
  browserTools: ToolSet;
  fillField: FillField;
  scrubber: SecretScrubber;
  budget: Budget;
  maxSteps: number;
  emit: (e: RunEventInput) => void;
  newFindingId: () => string;
}): Promise<{ result: RoleResult; usage: JobUsage }> {
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) throw new RangeError(`maxSteps must be a positive integer, got ${opts.maxSteps}`);
  const jobId = `role:${opts.persona.id}`;
  const emit = (e: RunEventInput) => opts.emit(opts.scrubber.scrub(e));
  const state = newSessionState(opts.project.goals);
  const queue = browserQueue(opts.browserTools, opts.fillField);
  const tools = {
    ...queue.tools,
    ...sessionTools({
      state,
      accounts: opts.project.accounts.filter((a) => a.ref === opts.persona.accountRef),
      emit, jobId,
      fillField: queue.fillField,
      scrubber: opts.scrubber, newId: opts.newFindingId,
    }),
  };
  const base = rolePrompt({
    persona: opts.persona, targetUrl: opts.project.targetUrl, docsUrl: opts.project.docsUrl,
    goals: opts.project.goals, accountRef: opts.persona.accountRef,
  });
  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };

  emit({ type: "job_started", jobId, kind: "role_session" });
  const { stoppedBy, error } = await runAgentLoop({
    model: opts.model,
    tools,
    instructions: () => base + sessionStatus(state.notes, [...state.goals.values()], usage.steps, opts.maxSteps),
    nudge: NUDGE,
    scrubber: opts.scrubber,
    budget: opts.budget,
    maxSteps: opts.maxSteps,
    usage,
    finished: () => state.finished !== null,
    crashed: queue.crashed,
    onStep: (step, costUsd) => emit({ type: "step", jobId, step: usage.steps, tool: step.toolCalls[0]?.toolName ?? null, costUsd }),
  });

  const result: RoleResult = opts.scrubber.scrub({
    persona: opts.persona.id,
    goals: [...state.goals.values()],
    findings: state.findings,
    stoppedBy,
    ...(error ? { error } : {}),
  });
  try {
    emit({ type: "job_finished", jobId, usage, stoppedBy, ...(error ? { error } : {}) });
  } catch {
    return { result: { ...result, stoppedBy: "error", error: result.error ?? "could not record the end of the session" }, usage };
  }
  return { result, usage };
}
