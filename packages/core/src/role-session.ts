import { generateText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { JobUsage, Persona, ProjectConfig, RoleResult, RunEventInput } from "@usetrawler/protocol";
import { pruneMessages } from "./context.ts";
import { type Budget, tallyStep } from "./llm.ts";
import { rolePrompt, sessionStatus } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { newSessionState, sessionTools, type FillField } from "./session-tools.ts";

const MAX_SILENT_TURNS = 3;
const MAX_BROWSER_CRASHES = 3;
const NUDGE = "Every turn must call a tool; plain text does nothing. Continue with the goals, and call finish once every goal has a status.";

const CUT_OFF = "Your reply was cut off before this tool ran. Call one tool at a time.";

function oneAtATime() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
}

function serialised(tools: ToolSet, run: ReturnType<typeof oneAtATime>, onCrash: () => void, onSuccess: () => void): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      {
        ...t,
        execute: (input: unknown, options: unknown) =>
          run(async () => {
            try {
              const out = await t.execute!(input as never, options as never);
              onSuccess();
              return out;
            } catch (err) {
              onCrash();
              throw err;
            }
          }),
      },
    ]),
  );
}

function answerUnrunToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return messages;
  const calls = last.content.filter((p) => p.type === "tool-call");
  if (calls.length === 0) return messages;
  return [
    ...messages,
    { role: "tool", content: calls.map((c) => ({ type: "tool-result" as const, toolCallId: c.toolCallId, toolName: c.toolName, output: { type: "error-text" as const, value: CUT_OFF } })) },
  ];
}

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
  let crashes = 0;
  const run = oneAtATime();
  const tools = {
    ...serialised(opts.browserTools, run, () => crashes++, () => (crashes = 0)),
    ...sessionTools({
      state,
      accounts: opts.project.accounts.filter((a) => a.ref === opts.persona.accountRef),
      emit, jobId,
      fillField: (ref, text, kind) => run(() => opts.fillField(ref, text, kind)),
      scrubber: opts.scrubber, newId: opts.newFindingId,
    }),
  };
  const base = rolePrompt({
    persona: opts.persona, targetUrl: opts.project.targetUrl, docsUrl: opts.project.docsUrl,
    goals: opts.project.goals, accountRef: opts.persona.accountRef,
  });
  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
  let stoppedBy: RoleResult["stoppedBy"] = "max_steps";
  let error: string | undefined;
  let emitFailure: unknown;

  emit({ type: "job_started", jobId, kind: "role_session" });
  const done = () => state.finished !== null || usage.steps >= opts.maxSteps || opts.budget.exceeded || crashes >= MAX_BROWSER_CRASHES || emitFailure !== undefined;
  let history: ModelMessage[] = [{ role: "user", content: "Begin." }];
  let silentTurns = 0;
  try {
    while (!done()) {
      const result = await generateText({
        model: opts.model,
        tools,
        messages: history,
        stopWhen: done,
        prepareStep: async ({ messages }) => ({
          instructions: opts.scrubber.scrub(base + sessionStatus(state.notes, [...state.goals.values()], usage.steps, opts.maxSteps)),
          messages: opts.scrubber.scrub(pruneMessages(messages, { keepLargeResults: 1, largeResultChars: 1500 })),
        }),
        onStepEnd: (step) => {
          const cost = tallyStep(usage, opts.budget, step);
          try {
            emit({ type: "step", jobId, step: usage.steps, tool: step.toolCalls[0]?.toolName ?? null, costUsd: cost });
          } catch (err) {
            emitFailure = err;
          }
        },
      });
      history = answerUnrunToolCalls([...history, ...result.responseMessages]);
      const last = result.steps.at(-1);
      if (done() || !last) break;
      if (last.toolCalls.length > 0) continue;
      silentTurns = result.steps.length > 1 ? 1 : silentTurns + 1;
      if (silentTurns >= MAX_SILENT_TURNS) {
        stoppedBy = "error";
        error = `the model stopped calling tools ${MAX_SILENT_TURNS} turns in a row`;
        break;
      }
      history = [...history, { role: "user", content: NUDGE }];
    }
    if (emitFailure !== undefined) throw emitFailure;
    if (state.finished !== null) stoppedBy = "finish";
    else if (crashes >= MAX_BROWSER_CRASHES) {
      stoppedBy = "error";
      error = `the browser failed ${MAX_BROWSER_CRASHES} times in a row`;
    } else if (opts.budget.exceeded) stoppedBy = "budget";
  } catch (err) {
    stoppedBy = "error";
    error = opts.scrubber.scrub(err instanceof Error ? err.message : String(err));
  }

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
