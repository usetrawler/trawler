import { generateText, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { VerdictSchema, type Finding, type JobStopReason, type JobUsage, type ProjectConfig, type ReplayObservation, type RunEventInput, type Verdict } from "@usetrawler/protocol";
import { browserQueue, oneAtATime, runAgentLoop } from "./agent-loop.ts";
import { type Budget, failureMessage, stoppedByRun, tallyStep } from "./llm.ts";
import { judgePrompt, replayPrompt } from "./prompts.ts";
import type { Screenshot } from "./browser.ts";
import type { BotProtection } from "./bot-protection.ts";
import type { SecretScrubber } from "./secrets.ts";
import { LOOK_TOOL, lookTool } from "./look.ts";
import { findingUrl, madeUpEmail, newSessionState, ownPasswordTool, sessionTools, type FillField } from "./session-tools.ts";

const NO_REPORT: ReplayObservation = { completed: false, observed: "the replay session wrote no report", blockedAt: null };
const NUDGE = "Every turn must call a tool; plain text does nothing. Carry on with the steps, and call report_replay when you are done or blocked.";

const MAX_OBSERVED_CODE_POINTS = 4000;
const JUDGE_OUTPUT_TOKENS = 8000;
const JUDGE_REPLIES = 2;
const CLOSE_TIMEOUT_MS = 10_000;

const isNoReport = (o: ReplayObservation) => !o.completed && o.blockedAt === null && !o.botProtection;

function onlyDefects(finding: Finding, what: string) {
  if (finding.kind !== "defect") throw new RangeError(`only defects are ${what}, ${finding.id} is ${finding.kind}`);
}

export function emitSafely(emit: (e: RunEventInput) => void, e: RunEventInput) {
  try {
    emit(e);
  } catch {
    return;
  }
}

export const emptyUsage = (model: string): JobUsage => ({ model, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 });

export interface ReplayBrowser {
  tools: ToolSet;
  fillField: FillField;
  screenshot?: () => Promise<Screenshot | null>;
  botProtection?: () => BotProtection | null;
  close?: () => Promise<void>;
}

interface Actor {
  id: string;
  name: string;
  accountRef?: string;
  browser: ReplayBrowser;
  queue: ReturnType<typeof browserQueue>;
  sign_in: ToolSet[string];
  ownPassword?: ToolSet[string];
}

export function peopleOf(finding: Finding): string[] {
  return finding.by ? [...new Set(finding.by)] : [];
}

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
  screenshot?: () => Promise<Screenshot | null>;
  keepScreenshot?: (findingId: string, shot: Screenshot) => void;
  botProtection?: () => BotProtection | null;
  openBrowser?: () => Promise<ReplayBrowser>;
  closeTimeoutMs?: number;
  look?: boolean;
}): Promise<{ observation: ReplayObservation; usage: JobUsage }> {
  onlyDefects(opts.finding, "replayed");
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) throw new RangeError(`maxSteps must be a positive integer, got ${opts.maxSteps}`);
  const jobId = `replay:${opts.finding.id}`;
  const emit = (e: RunEventInput) => opts.emit(opts.scrubber.scrub(e));
  const stepCount = opts.finding.reproduction.length;
  const people = peopleOf(opts.finding);
  const known = people.filter((id) => opts.project.personas.some((p) => p.id === id));
  const together = known.length >= 1 && known.length === people.length && (known.length === 1 || opts.openBrowser !== undefined);
  const persona = (id: string) => opts.project.personas.find((p) => p.id === id)!;
  const actors = new Map<string, Promise<Actor>>();
  const opened: ReplayBrowser[] = [];
  const open = async (id: string, first: boolean): Promise<Actor> => {
    const browser = first ? { tools: opts.browserTools, fillField: opts.fillField, screenshot: opts.screenshot, botProtection: opts.botProtection } : await opts.openBrowser!();
    if (!first) opened.push(browser);
    const accountRef = together ? persona(id).accountRef : opts.accountRef;
    const queue = browserQueue(browser.tools);
    const state = newSessionState([]);
    const { sign_in } = sessionTools({
      state,
      accounts: opts.project.accounts.filter((a) => a.ref === accountRef),
      emit, jobId,
      fillField: browser.fillField, inBrowser: queue.run,
      scrubber: opts.scrubber,
      newId: () => "unused",
    });
    const own = accountRef ? undefined : ownPasswordTool({ state, fillField: browser.fillField, inBrowser: queue.run, scrubber: opts.scrubber }).type_own_password;
    return { id, name: together ? persona(id).name : "you", accountRef, browser, queue, sign_in, ownPassword: own };
  };
  const actorFor = (id: string): Promise<Actor> => {
    const existing = actors.get(id);
    if (existing) return existing;
    const pending = open(id, actors.size === 0);
    actors.set(id, pending);
    pending.catch(() => actors.delete(id));
    return pending;
  };
  const inOrder = oneAtATime();
  let current = together ? opts.finding.by![0]! : "you";
  const now = () => actorFor(current);
  let report: ReplayObservation | null = null;
  let stoppedAt: BotProtection | null = null;
  const report_replay = tool({
    description: "Report what you saw while following the steps. completed is true only if you carried out every step; otherwise give the number of the step you could not do as blockedAt.",
    inputSchema: z.object({ completed: z.boolean().nullish(), observed: z.string().nullish(), blockedAt: z.number().nullish() }),
    execute: async ({ completed, observed, blockedAt }) => inOrder(async () => {
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
  const delegate = (name: string, definition: ToolSet[string]): ToolSet[string] => ({
    ...definition,
    execute: async (input: unknown, options: unknown) => inOrder(async () => {
      const actor = track(await now());
      const own = name === "type_own_password" ? actor.ownPassword : name === "sign_in" ? actor.sign_in : actor.queue.tools[name];
      if (!own?.execute) return `rejected: ${actor.name} ${name === "type_own_password" ? "has an account; use sign_in" : "cannot do that"}`;
      const out = await own.execute(input as never, options as never);
      const met = actor.browser.botProtection?.() ?? null;
      if (met && !stoppedAt) {
        stoppedAt = met;
        emit({ type: "bot_protection", jobId, vendor: met.vendor, url: findingUrl(met.url) ?? "" });
      }
      return out;
    }),
  });
  const first = await actorFor(current);
  const crashedActors: Actor[] = [first];
  const track = (actor: Actor) => (crashedActors.includes(actor) ? actor : (crashedActors.push(actor), actor));
  const anyWithoutAccount = together ? known.some((id) => !persona(id).accountRef) : !opts.accountRef;
  const ownDefinition = anyWithoutAccount ? (first.ownPassword ?? ownPasswordTool({ state: newSessionState([]), fillField: opts.fillField, inBrowser: first.queue.run, scrubber: opts.scrubber }).type_own_password) : undefined;
  const act_as = tool({
    description: "Switch to the person who does the next steps. Each person has their own browser and stays signed in as themselves.",
    inputSchema: z.object({ person: z.string().nullish() }),
    execute: async ({ person }) => inOrder(async () => {
      const id = known.find((k) => persona(k).name.toLowerCase() === (person ?? "").trim().toLowerCase());
      if (!id) return `rejected: person: use one of ${known.map((k) => persona(k).name).join(", ")}`;
      try {
        await actorFor(id);
      } catch (err) {
        return `rejected: ${persona(id).name}'s browser could not be opened (${err instanceof Error ? err.message : String(err)}); you are still ${persona(current).name}`;
      }
      current = id;
      return `you are now ${persona(id).name}, in their own browser; take a browser_snapshot`;
    }),
  });
  const pictureOfCurrentPage = () => inOrder(async () => {
    const actor = track(await now());
    const screenshot = actor.browser.screenshot;
    return screenshot ? actor.queue.run(screenshot) : null;
  });
  const look = opts.look === true && opts.screenshot !== undefined;
  const lookAtCurrentPage = lookTool({ screenshot: pictureOfCurrentPage });
  const browserTools = Object.fromEntries(Object.entries(first.queue.tools).map(([name, t]) => [name, delegate(name, t)]));
  const tools: ToolSet = {
    ...browserTools,
    sign_in: delegate("sign_in", first.sign_in),
    report_replay,
    ...(ownDefinition ? { type_own_password: delegate("type_own_password", ownDefinition) } : {}),
    ...(together && known.length > 1 ? { act_as } : {}),
    ...(look ? { [LOOK_TOOL]: lookAtCurrentPage } : {}),
  };
  const instructions = together
    ? replayPrompt({
        targetUrl: opts.project.targetUrl, steps: opts.finding.reproduction,
        people: known.map((id) => ({ name: persona(id).name, accountRef: persona(id).accountRef, signUpEmail: persona(id).accountRef ? undefined : madeUpEmail(`replay-${id}`) })),
        stepPeople: opts.finding.by!.map((id) => persona(id).name), look,
      })
    : replayPrompt({ targetUrl: opts.project.targetUrl, steps: opts.finding.reproduction, accountRef: opts.accountRef, signUpEmail: opts.accountRef ? undefined : madeUpEmail("replay"), look });
  const usage = emptyUsage(opts.modelId);

  emit({ type: "job_started", jobId, kind: "replay" });
  try {
    const outcome = await runAgentLoop({
      model: opts.model,
      tools,
      instructions: () => `${instructions}\n\nTurn ${usage.steps + 1} of ${opts.maxSteps}.`,
      nudge: NUDGE,
      scrubber: opts.scrubber,
      budget: opts.budget,
      maxSteps: opts.maxSteps,
      usage,
      finished: () => report !== null || stoppedAt !== null,
      crashed: () => crashedActors.map((a) => a.queue.crashed()).find((c) => c !== false) ?? false,
      onStep: (step, costUsd) => emit({ type: "step", jobId, step: usage.steps, tool: step.toolCalls[0]?.toolName ?? null, costUsd }),
      largeResultChars: 4000,
    });
    const last = await now();
    const observation: ReplayObservation = stoppedAt ? opts.scrubber.scrub(stoppedByBotProtection(stoppedAt)) : (report ?? NO_REPORT);
    const screenshot = last.browser.screenshot;
    if (screenshot && opts.keepScreenshot && outcome.stoppedBy !== "budget") {
      const shot = await screenshot().catch(() => null);
      if (shot) opts.keepScreenshot(opts.finding.id, shot);
    }
    const stoppedBy: JobStopReason = outcome.stoppedBy === "finish" ? "report" : outcome.stoppedBy;
    emitSafely(emit, { type: "job_finished", jobId, usage, stoppedBy, ...(outcome.error ? { error: outcome.error } : {}) });
    return { observation, usage };
  } finally {
    const limit = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    await Promise.allSettled(opened.map(async (b) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.resolve(b.close?.()).catch(() => undefined), new Promise((resolve) => (timer = setTimeout(resolve, limit)))]);
      clearTimeout(timer);
    }));
  }
}

function stoppedByBotProtection(met: BotProtection): ReplayObservation {
  return {
    completed: false,
    observed: `The replay could not go on: ${met.vendor}'s bot-protection check at ${met.url} stopped it. A person in an ordinary browser gets past such a check, so it says nothing about the claim.`,
    blockedAt: null,
    botProtection: met,
  };
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
  if (opts.observation.botProtection) verdict = "inconclusive";
  else if (isNoReport(opts.observation)) stoppedBy = "no_report";
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
