import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { JobStopReason, JobUsage, ProjectConfig, RunEventInput, SignInCheck } from "@usetrawler/protocol";
import { browserQueue, runAgentLoop } from "./agent-loop.ts";
import type { Budget } from "./llm.ts";
import { accountCheckPrompt } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { newSessionState, sessionTools, type FillField } from "./session-tools.ts";

const NUDGE = "Every turn must call a tool; plain text does nothing. Sign in with the account, then call report_sign_in.";
const NO_REPORT: SignInCheck = { outcome: "unclear", observed: "the check wrote no report" };
const MAX_OBSERVED = 1000;

export async function checkAccount(opts: {
  model: LanguageModel;
  modelId: string;
  project: ProjectConfig;
  accountRef: string;
  browserTools: ToolSet;
  fillField: FillField;
  scrubber: SecretScrubber;
  budget: Budget;
  maxSteps: number;
  emit: (e: RunEventInput) => void;
}): Promise<{ signIn: SignInCheck; usage: JobUsage; stoppedBy: JobStopReason; error?: string }> {
  const account = opts.project.accounts.find((a) => a.ref === opts.accountRef);
  if (!account) throw new RangeError(`account ${opts.accountRef} is not in the project`);
  const jobId = `account:${opts.accountRef}`;
  const emit = (e: RunEventInput) => opts.emit(opts.scrubber.scrub(e));
  const queue = browserQueue(opts.browserTools);
  const state = newSessionState([]);
  const tools = sessionTools({
    state, accounts: [account], emit, jobId,
    fillField: opts.fillField, inBrowser: queue.run, scrubber: opts.scrubber, newId: () => "unused",
  });
  let attempted = false;
  let typed = false;
  const sign_in = tool({
    description: tools.sign_in.description,
    inputSchema: z.object({ account: z.string(), usernameField: z.string(), passwordField: z.string() }),
    execute: async (input, options) => {
      if (attempted) return "rejected: you already signed in once; look at the page and call report_sign_in";
      const result = String(await tools.sign_in.execute!(input, options));
      if (result.startsWith("rejected:")) return result;
      attempted = true;
      typed = !result.startsWith("failed:");
      return result;
    },
  });
  let report: SignInCheck | null = null;
  const report_sign_in = tool({
    description: "Report whether signing in with the account worked: signed_in when you are inside the product as that account, refused when the product said the username or password is wrong, unclear otherwise. observed: what the page showed.",
    inputSchema: z.object({ outcome: z.string().nullish(), observed: z.string().nullish() }),
    execute: async ({ outcome, observed }) => queue.run(async () => {
      if (report) return "rejected: already reported";
      if (outcome !== "signed_in" && outcome !== "refused" && outcome !== "unclear") return "rejected: outcome: signed_in, refused or unclear";
      if (!observed?.trim()) return "rejected: observed: describe what the page showed";
      if (outcome === "refused" && !typed) return "rejected: outcome: the username and password were never typed, so the product cannot have refused them; report unclear";
      report = { outcome, observed: Array.from(opts.scrubber.scrub(observed.trim())).slice(0, MAX_OBSERVED).join("") };
      return "reported";
    }),
  });
  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
  const instructions = accountCheckPrompt({ targetUrl: opts.project.targetUrl, accountRef: opts.accountRef });

  emit({ type: "job_started", jobId, kind: "account_check" });
  const outcome = await runAgentLoop({
    model: opts.model,
    tools: { ...queue.tools, sign_in, report_sign_in },
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
  const stoppedBy: JobStopReason = outcome.stoppedBy === "finish" ? "report" : outcome.stoppedBy;
  try {
    emit({ type: "job_finished", jobId, usage, stoppedBy, ...(outcome.error ? { error: outcome.error } : {}) });
  } catch {
    return { signIn: report ?? NO_REPORT, usage, stoppedBy: "error", error: "the check could not report its result" };
  }
  return { signIn: report ?? NO_REPORT, usage, stoppedBy, ...(outcome.error ? { error: outcome.error } : {}) };
}
