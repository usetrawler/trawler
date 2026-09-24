import { generateText, isStepCount, type LanguageModel, type ToolSet } from "ai";
import type { JobUsage, Persona, ProjectConfig, RoleResult, RunEventInput } from "@usetrawler/protocol";
import { pruneMessages } from "./context.ts";
import { type Budget, tallyStep } from "./llm.ts";
import { rolePrompt, sessionStatus } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { newSessionState, sessionTools, type FillField } from "./session-tools.ts";

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
  const jobId = `role:${opts.persona.id}`;
  const emit = (e: RunEventInput) => opts.emit(opts.scrubber.scrub(e));
  const state = newSessionState(opts.project.goals);
  const tools = {
    ...opts.browserTools,
    ...sessionTools({
      state, accounts: opts.project.accounts, emit, jobId,
      fillField: opts.fillField, scrubber: opts.scrubber, newId: opts.newFindingId,
    }),
  };
  const base = rolePrompt({
    persona: opts.persona, targetUrl: opts.project.targetUrl, docsUrl: opts.project.docsUrl,
    goals: opts.project.goals, accountRef: opts.persona.accountRef,
  });
  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
  let stoppedBy: RoleResult["stoppedBy"] = "max_steps";

  emit({ type: "job_started", jobId, kind: "role_session" });
  try {
    await generateText({
      model: opts.model,
      tools,
      prompt: "Begin.",
      stopWhen: [isStepCount(opts.maxSteps), () => state.finished !== null, () => opts.budget.exceeded],
      prepareStep: async ({ messages }) => ({
        system: opts.scrubber.scrub(base + sessionStatus(state.notes, [...state.goals.values()])),
        messages: opts.scrubber.scrub(pruneMessages(messages, { keepLargeResults: 1, largeResultChars: 4000 })),
      }),
      onStepEnd: (step) => {
        const cost = tallyStep(usage, opts.budget, step);
        emit({ type: "step", jobId, step: usage.steps, tool: step.toolCalls[0]?.toolName ?? null, costUsd: cost });
      },
    });
    if (state.finished !== null) stoppedBy = "finish";
    else if (opts.budget.exceeded) stoppedBy = "budget";
  } catch {
    stoppedBy = "error";
  }

  const result: RoleResult = { persona: opts.persona.id, goals: [...state.goals.values()], findings: state.findings, stoppedBy };
  emit({ type: "job_finished", jobId, usage, stoppedBy });
  return { result, usage };
}
