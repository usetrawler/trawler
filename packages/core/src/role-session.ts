import type { LanguageModel, ToolSet } from "ai";
import type { Screenshot } from "./browser.ts";
import { FindingSchema, goalsFor, type JobUsage, type NotABug, type Persona, type ProjectConfig, type RoleResult, type RunEventInput, type StoryEntry } from "@usetrawler/protocol";
import { browserQueue, OUTAGE_WAITS_MS, runAgentLoop } from "./agent-loop.ts";
import type { Budget } from "./llm.ts";
import { REVISITS_STOP, rolePrompt, sessionStatus, standbyPrompt, stuckHints, wrapUpPrompt, type Revisit, type WrapUp } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { findingUrl, madeUpEmail, madeUpPassword, newSessionState, noteBotProtection, ownPasswordTool, sessionTools, STANDBY, teamTools, type FillField, type TeamChannel } from "./session-tools.ts";
import type { BotProtection } from "./bot-protection.ts";
import { LOOK_TOOL, lookTool } from "./look.ts";
import { accountFromStory, accountNote, type AccountFormRead, type AccountRecord } from "./account-note.ts";

const NOTHING_NEWER = 999_999_999_999_999;
const MAX_STEP_URL = 990;
const PROGRESS_TOOLS = new Set(["goal_status", "submit_finding", "note", "say_to_team", "finish"]);
const WRAP_UP_TOOLS = ["note", "submit_finding", "goal_status", "finish", "say_to_team", "read_team_channel", LOOK_TOOL];
const NUDGE = "Every turn must call a tool; plain text does nothing. Continue with the goals, and call finish once every goal has a status.";

export async function runRoleSession(opts: {
  model: LanguageModel;
  modelId: string;
  persona: Persona;
  project: ProjectConfig;
  browserTools: ToolSet;
  fillField: FillField;
  accountForm?: (passwordRef: string) => Promise<AccountFormRead | null>;
  scrubber: SecretScrubber;
  budget: Budget;
  maxSteps: number;
  emit: (e: RunEventInput) => void;
  newFindingId: () => string;
  screenshot?: () => Promise<Screenshot | null>;
  keepScreenshot?: (findingId: string, shot: Screenshot) => void;
  pageUrl?: () => string | null;
  botProtection?: () => BotProtection | null;
  goalIds?: string[];
  story?: StoryEntry[];
  signUpSeed?: string;
  returning?: boolean;
  notBugs?: NotABug[];
  jobId?: string;
  look?: boolean;
  conversation?: { peers: { id: string; name: string }[]; channel: TeamChannel };
  outageWaitsMs?: number[];
}): Promise<{ result: RoleResult; usage: JobUsage }> {
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) throw new RangeError(`maxSteps must be a positive integer, got ${opts.maxSteps}`);
  const jobId = opts.jobId ?? `role:${opts.persona.id}`;
  const emit = (e: RunEventInput) => opts.emit(opts.scrubber.scrub(e));
  const own = goalsFor(opts.project.goals, opts.persona.id);
  const goals = opts.goalIds ? own.filter((g) => opts.goalIds!.includes(g.id)) : own;
  if (goals.length === 0) throw new RangeError(`this turn gives ${opts.persona.id} no goals of theirs`);
  const seed = opts.signUpSeed === undefined ? undefined : `${opts.signUpSeed}:${opts.persona.id}`;
  const state = newSessionState(goals);
  const earlierAccount = opts.returning ? accountFromStory(opts.story ?? [], opts.persona.id) : null;
  let lastAccountNote = earlierAccount ? accountNote(earlierAccount) : undefined;
  const rememberAccount = (record: AccountRecord) => {
    const text = accountNote(record);
    if (text === lastAccountNote) return;
    lastAccountNote = text;
    emit({ type: "note", jobId, text });
  };
  const queue = browserQueue(opts.browserTools, (ok) => {
    state.page = ok ? "seen" : "stale";
    if (ok) noteBotProtection(state, opts.botProtection?.() ?? null, emit, jobId);
  });
  const { screenshot, keepScreenshot } = opts;
  const capture = screenshot && keepScreenshot
    ? async (findingId: string) => {
        const shot = await queue.run(screenshot);
        if (shot) keepScreenshot(findingId, shot);
      }
    : undefined;
  const look: ToolSet = opts.look && screenshot ? { [LOOK_TOOL]: lookTool({ screenshot: () => queue.run(screenshot) }) } : {};
  const conversation = opts.conversation;
  const tools = {
    ...queue.tools,
    ...look,
    ...sessionTools({
      state,
      accounts: opts.project.accounts.filter((a) => a.ref === opts.persona.accountRef),
      emit, jobId,
      fillField: opts.fillField, inBrowser: queue.run,
      scrubber: opts.scrubber, newId: opts.newFindingId, capture, pageUrl: opts.pageUrl, botProtection: opts.botProtection,
      people: opts.project.personas.map((p) => ({ id: p.id, name: p.name })), self: opts.persona.id,
      othersAreWorking: conversation ? async () => {
        try {
          if (!conversation.channel.othersWorking) return false;
          await conversation.channel.read(NOTHING_NEWER, 0);
        } catch {
          return false;
        }
        return conversation.channel.othersWorking?.() === true;
      } : undefined,
    }),
    ...(conversation ? teamTools({ state, emit, jobId, channel: conversation.channel, scrubber: opts.scrubber }) : {}),
    ...(opts.persona.accountRef ? {} : ownPasswordTool({ state, fillField: opts.fillField, inBrowser: queue.run, scrubber: opts.scrubber, password: seed === undefined ? undefined : madeUpPassword(seed), accountForm: opts.accountForm, pageUrl: opts.pageUrl, onAccount: rememberAccount })),
  };
  const base = rolePrompt({
    persona: opts.persona, targetUrl: opts.project.targetUrl, docsUrl: opts.project.docsUrl, brief: opts.project.brief, setup: opts.project.setup,
    goals, accountRef: opts.persona.accountRef,
    signUpEmail: opts.persona.accountRef ? undefined : madeUpEmail(opts.persona.id, seed),
    story: opts.story, returning: opts.returning, notBugs: opts.notBugs, look: LOOK_TOOL in look,
    others: opts.project.personas.filter((p) => p.id !== opts.persona.id).map((p) => p.name),
    team: opts.conversation?.peers.map((p) => p.name),
  });
  let standbyFrom: number | undefined;
  let sinceStatus = 0;
  let arrivals = new Map<string, number>();
  let lastUrl: string | null = null;
  let circling: { goal: string; url: string; count: number } | null = null;
  let outOfSteps = false;
  const circledGoals = new Set<string>();
  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
  const openGoals = () => [...state.goals.values()].filter((g) => g.status === "not_attempted");
  const revisits = (): Revisit[] => [...arrivals].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count);
  const wrapUp = (): WrapUp | null => {
    if (state.standby || state.finished !== null) return null;
    const open = openGoals().length;
    if (open === 0) return { reason: "settled" };
    if (circling) return { reason: "circling", ...circling };
    const stepsLeft = opts.maxSteps - usage.steps;
    outOfSteps ||= stepsLeft <= Math.min(open + 2, Math.floor(opts.maxSteps / 4));
    return outOfSteps ? { reason: "out_of_steps", stepsLeft } : null;
  };
  const reproducible = (url: string) => (url.length <= MAX_STEP_URL ? url : `${new URL(url).origin}${new URL(url).pathname}`.slice(0, MAX_STEP_URL));
  const recordCircling = (goal: string, url: string, count: number) => {
    if (circledGoals.has(goal)) return;
    circledGoals.add(goal);
    const title = `Went in circles around ${new URL(url).pathname}`.slice(0, 300);
    const visited = revisits();
    const parsed = FindingSchema.safeParse({
      id: opts.newFindingId(),
      kind: "friction",
      goal,
      severity: "low",
      title,
      observed: `${opts.persona.name} came back to ${url} ${count} times without getting further or recording anything, so Trawler closed the browser until the goal had a status. Pages visited since the last progress, with how often: ${visited.map((v) => `${v.url} (${v.count})`).join(", ")}. This usually means the goal is unclear, or the product gives no way forward from these pages.`.slice(0, 4000),
      reproduction: [...new Set([...arrivals.keys()].map(reproducible))].slice(0, 30).map((u) => `Open ${u}`),
      url,
    });
    if (!parsed.success) return;
    emit({ type: "finding", jobId, finding: parsed.data });
    state.findings.push(parsed.data);
  };

  emit({ type: "job_started", jobId, kind: "role_session" });
  if (earlierAccount) emit({ type: "note", jobId, text: accountNote(earlierAccount) });
  const { stoppedBy, error } = await runAgentLoop({
    model: opts.model,
    tools,
    instructions: () => {
      const wrap = wrapUp();
      const hints = state.standby ? standbyPrompt() : wrap ? wrapUpPrompt(wrap) : stuckHints({ sinceStatus, revisits: revisits(), openGoals: openGoals().length });
      return base + sessionStatus(state.notes, [...state.goals.values()], usage.steps, opts.maxSteps) + hints;
    },
    activeTools: () => {
      state.browserClosed = wrapUp() !== null;
      return state.browserClosed ? WRAP_UP_TOOLS.filter((name) => name in tools) : undefined;
    },
    nudge: NUDGE,
    outageWaitsMs: opts.outageWaitsMs ?? OUTAGE_WAITS_MS,
    scrubber: opts.scrubber,
    budget: opts.budget,
    maxSteps: opts.maxSteps,
    usage,
    finished: () => state.finished !== null,
    crashed: queue.crashed,
    onStep: (step, costUsd) => {
      if (state.standby) {
        standbyFrom ??= usage.steps;
        const over = usage.steps - standbyFrom >= STANDBY.maxTurns || Date.now() - state.standby.since >= STANDBY.maxMs || usage.steps >= opts.maxSteps || opts.budget.exceeded || queue.crashed() !== false;
        if (over) state.finished = state.standby.summary;
      }
      const url = findingUrl(opts.pageUrl?.());
      const tool = step.toolCalls[0]?.toolName ?? null;
      const accepted = step.toolResults.filter((r) => !(typeof r.output === "string" && r.output.startsWith("rejected"))).map((r) => r.toolName);
      sinceStatus = accepted.includes("goal_status") ? 0 : sinceStatus + 1;
      if (accepted.includes("goal_status")) circling = null;
      let circled: { url: string; count: number } | null = null;
      if (accepted.some((name) => PROGRESS_TOOLS.has(name))) arrivals = new Map();
      else if (url && url !== lastUrl && !state.standby) {
        const count = (arrivals.get(url) ?? 0) + 1;
        arrivals.set(url, count);
        if (count >= REVISITS_STOP && !circling) circled = { url, count };
      }
      if (url) lastUrl = url;
      emit({ type: "step", jobId, step: usage.steps, tool, costUsd, ...(url ? { url } : {}) });
      const goal = circled && openGoals()[0];
      if (circled && goal) {
        circling = { goal: goal.goal, ...circled };
        recordCircling(goal.goal, circled.url, circled.count);
      }
    },
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
