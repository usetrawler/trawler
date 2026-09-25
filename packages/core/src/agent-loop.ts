import { generateText, type LanguageModel, type ModelMessage, type StepResult, type ToolSet } from "ai";
import type { JobUsage, StopReason } from "@usetrawler/protocol";
import { pruneMessages } from "./context.ts";
import { type Budget, failureMessage, stoppedByRun, tallyStep } from "./llm.ts";
import type { SecretScrubber } from "./secrets.ts";
import type { FillField } from "./session-tools.ts";

const MAX_SILENT_TURNS = 3;
const MAX_CUT_OFFS = 3;
const MAX_BROWSER_CRASHES = 3;
const CUT_OFF = "Your reply was cut off before this tool ran. Call one tool at a time.";
const CUT_OFF_TEXT = "Your reply was cut off. Plain text does nothing; call one tool at a time.";

function oneAtATime() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
}

export function browserQueue(browserTools: ToolSet, fillField: FillField, onOutcome: (ok: boolean) => void = () => {}) {
  const run = oneAtATime();
  let crashes = 0;
  let lastError = "";
  const tools: ToolSet = Object.fromEntries(
    Object.entries(browserTools).map(([name, t]) => [
      name,
      {
        ...t,
        execute: (input: unknown, options: unknown) =>
          run(async () => {
            try {
              const out = await t.execute!(input as never, options as never);
              crashes = 0;
              onOutcome(true);
              return out;
            } catch (err) {
              crashes++;
              onOutcome(false);
              lastError = err instanceof Error ? err.message : String(err);
              throw err;
            }
          }),
      },
    ]),
  );
  return {
    tools,
    run,
    fillField: ((ref, text, kind) => run(() => fillField(ref, text, kind))) as FillField,
    crashed: (): string | false => (crashes >= MAX_BROWSER_CRASHES ? lastError || "no error text" : false),
  };
}

function answerUnrunToolCalls(messages: ModelMessage[]): { messages: ModelMessage[]; answered: number } {
  const at = messages.findLastIndex((m) => m.role === "assistant");
  const assistant = messages[at];
  if (!assistant || assistant.role !== "assistant" || typeof assistant.content === "string") return { messages, answered: 0 };
  const done = new Set(
    messages.slice(at + 1).flatMap((m) => (m.role === "tool" ? m.content.filter((p) => p.type === "tool-result").map((p) => p.toolCallId) : [])),
  );
  const open = assistant.content.filter((p) => p.type === "tool-call" && !done.has(p.toolCallId));
  if (open.length === 0) return { messages, answered: 0 };
  const results = open.map((c) => ({ type: "tool-result" as const, toolCallId: (c as { toolCallId: string }).toolCallId, toolName: (c as { toolName: string }).toolName, output: { type: "error-text" as const, value: CUT_OFF } }));
  return { messages: [...messages, { role: "tool", content: results }], answered: open.length };
}

export async function runAgentLoop(opts: {
  model: LanguageModel;
  tools: ToolSet;
  instructions: () => string;
  nudge: string;
  scrubber: SecretScrubber;
  budget: Budget;
  maxSteps: number;
  usage: JobUsage;
  finished: () => boolean;
  crashed: () => string | false;
  onStep: (step: StepResult<ToolSet>, costUsd: number) => void;
  largeResultChars?: number;
}): Promise<{ stoppedBy: StopReason; error?: string }> {
  const { usage } = opts;
  let stepFailure: unknown;
  const done = () => opts.finished() || usage.steps >= opts.maxSteps || opts.budget.exceeded || opts.crashed() !== false || stepFailure !== undefined;
  let history: ModelMessage[] = [{ role: "user", content: "Begin." }];
  let silentTurns = 0;
  let cutOffs = 0;
  try {
    while (!done()) {
      const result = await generateText({
        model: opts.model,
        tools: opts.tools,
        messages: history,
        stopWhen: [done, ({ steps }) => steps.at(-1)?.finishReason === "length"],
        prepareStep: async ({ messages }) => ({
          instructions: opts.scrubber.scrub(opts.instructions()),
          messages: opts.scrubber.scrub(pruneMessages(messages, { keepLargeResults: 1, largeResultChars: opts.largeResultChars ?? 1500 })),
        }),
        onStepEnd: (step) => {
          const cost = tallyStep(usage, opts.budget, step);
          try {
            opts.onStep(step, cost);
          } catch (err) {
            stepFailure = err;
          }
        },
      });
      const answered = answerUnrunToolCalls([...history, ...result.responseMessages]);
      history = answered.messages;
      const last = result.steps.at(-1);
      if (done() || !last) break;
      if (result.steps.length > 1) {
        silentTurns = 0;
        cutOffs = 0;
      }
      if (last.finishReason === "length" || answered.answered > 0) {
        cutOffs++;
        if (cutOffs >= MAX_CUT_OFFS) return { stoppedBy: "error", error: `the model's replies were cut off ${MAX_CUT_OFFS} times in a row` };
        if (last.toolCalls.length === 0) history = [...history, { role: "user", content: CUT_OFF_TEXT }];
        continue;
      }
      if (last.toolCalls.length > 0) continue;
      silentTurns++;
      if (silentTurns >= MAX_SILENT_TURNS) return { stoppedBy: "error", error: `the model stopped calling tools ${MAX_SILENT_TURNS} turns in a row` };
      history = [...history, { role: "user", content: opts.nudge }];
    }
    if (stepFailure !== undefined) throw stepFailure;
    if (opts.finished()) return { stoppedBy: "finish" };
    const crash = opts.crashed();
    if (crash !== false) return { stoppedBy: "error", error: `the browser failed ${MAX_BROWSER_CRASHES} times in a row; last error: ${opts.scrubber.scrub(crash).slice(0, 500)}` };
    if (opts.budget.exceeded) return { stoppedBy: "budget" };
    return { stoppedBy: "max_steps" };
  } catch (err) {
    if (stoppedByRun(err)) return { stoppedBy: "budget" };
    return { stoppedBy: "error", error: opts.scrubber.scrub(failureMessage(err)) };
  }
}
