import type { LanguageModel, ToolSet } from "ai";
import type { Screenshot } from "./browser.ts";
import { goalsFor, type JobUsage, type Persona, type ProjectConfig, type RoleResult, type RunEventInput, type StoryEntry } from "@usetrawler/protocol";
import { browserQueue, runAgentLoop } from "./agent-loop.ts";
import type { Budget } from "./llm.ts";
import { rolePrompt, sessionStatus } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { madeUpEmail, madeUpPassword, newSessionState, ownPasswordTool, sessionTools, type FillField } from "./session-tools.ts";

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
  screenshot?: () => Promise<Screenshot | null>;
  keepScreenshot?: (findingId: string, shot: Screenshot) => void;
  pageUrl?: () => string | null;
  goalIds?: string[];
  story?: StoryEntry[];
  signUpSeed?: string;
  returning?: boolean;
  jobId?: string;
}): Promise<{ result: RoleResult; usage: JobUsage }> {
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) throw new RangeError(`maxSteps must be a positive integer, got ${opts.maxSteps}`);
  const jobId = opts.jobId ?? `role:${opts.persona.id}`;
  const emit = (e: RunEventInput) => opts.emit(opts.scrubber.scrub(e));
  const own = goalsFor(opts.project.goals, opts.persona.id);
  const goals = opts.goalIds ? own.filter((g) => opts.goalIds!.includes(g.id)) : own;
  if (goals.length === 0) throw new RangeError(`this turn gives ${opts.persona.id} no goals of theirs`);
  const seed = opts.signUpSeed === undefined ? undefined : `${opts.signUpSeed}:${opts.persona.id}`;
  const state = newSessionState(goals);
  const queue = browserQueue(opts.browserTools, (ok) => (state.page = ok ? "seen" : "stale"));
  const { screenshot, keepScreenshot } = opts;
  const capture = screenshot && keepScreenshot
    ? async (findingId: string) => {
        const shot = await queue.run(screenshot);
        if (shot) keepScreenshot(findingId, shot);
      }
    : undefined;
  const tools = {
    ...queue.tools,
    ...sessionTools({
      state,
      accounts: opts.project.accounts.filter((a) => a.ref === opts.persona.accountRef),
      emit, jobId,
      fillField: opts.fillField, inBrowser: queue.run,
      scrubber: opts.scrubber, newId: opts.newFindingId, capture, pageUrl: opts.pageUrl,
      people: opts.project.personas.map((p) => ({ id: p.id, name: p.name })), self: opts.persona.id,
    }),
    ...(opts.persona.accountRef ? {} : ownPasswordTool({ state, fillField: opts.fillField, inBrowser: queue.run, scrubber: opts.scrubber, password: seed === undefined ? undefined : madeUpPassword(seed) })),
  };
  const base = rolePrompt({
    persona: opts.persona, targetUrl: opts.project.targetUrl, docsUrl: opts.project.docsUrl,
    goals, accountRef: opts.persona.accountRef,
    signUpEmail: opts.persona.accountRef ? undefined : madeUpEmail(opts.persona.id, seed),
    story: opts.story, returning: opts.returning,
    others: opts.project.personas.filter((p) => p.id !== opts.persona.id).map((p) => p.name),
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
