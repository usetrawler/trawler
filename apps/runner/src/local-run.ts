import { randomBytes } from "node:crypto";
import type { LanguageModel } from "ai";
import { Budget, checkAccount, judge, planSecondRound, runReplay, runRoleSession, SecretScrubber, seenPages, type Browser } from "@usetrawler/core";
import { ACCOUNT_CHECK_STEPS, trimStory, turnsOf, type Persona, type ProjectConfig, type RoleResult, type RunEventInput, type StoryEntry } from "@usetrawler/protocol";
import type { RunSummary } from "./run-dir.ts";
import { blockedRequest } from "./blocked-request.ts";

const CLOSE_TIMEOUT_MS = 10_000;
export const SECOND_ROUND_JOB = "plan:second-round";
const MAX_JOB_ERROR = 2000;

export type OpenBrowser = (opts: { onBlocked: (url: string, cause?: string) => void; scrubber: SecretScrubber }) => Promise<Browser>;

export async function localRun(opts: {
  project: ProjectConfig;
  agentModel: LanguageModel;
  agentModelId: string;
  judgeModel: LanguageModel;
  judgeModelId: string;
  budgetUsd: number;
  maxSteps: number;
  replaySteps: number;
  emit: (e: RunEventInput) => void;
  openBrowser: OpenBrowser;
  look?: boolean;
  secondRound?: boolean;
}): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const budget = new Budget(opts.budgetUsd);
  const summary: RunSummary = {
    project: opts.project.name, agentModel: opts.agentModelId, judgeModel: opts.judgeModelId,
    startedAt, finishedAt: startedAt, budgetUsd: opts.budgetUsd, totalCostUsd: 0, jobs: [], roles: [], replays: {}, replayErrors: {}, verdicts: {}, judgeErrors: {},
    people: Object.fromEntries(opts.project.personas.map((p) => [p.id, p.name])),
    browserFailures: [],
  };
  const scrubberFor = () => SecretScrubber.forProject(opts.project);
  let findingNo = 0;

  const blockedFor = (jobId: string, scrubber: SecretScrubber) => (url: string, cause?: string) => {
    try {
      const event = scrubber.scrub(blockedRequest(jobId, url, cause));
      opts.emit(event);
      if (cause && event.type === "blocked_request") summary.browserFailures!.push({ jobId, url: event.url, cause });
    } catch {
      return;
    }
  };
  const withBrowser = async <T>(jobId: string, scrubber: SecretScrubber, fn: (b: Browser) => Promise<T>): Promise<T> => {
    const browser = await opts.openBrowser({ onBlocked: blockedFor(jobId, scrubber), scrubber });
    try {
      return await fn(browser);
    } finally {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([browser.close().catch(() => undefined), new Promise((r) => (timer = setTimeout(r, CLOSE_TIMEOUT_MS)))]);
      clearTimeout(timer);
    }
  };
  const failure = (scrubber: SecretScrubber, err: unknown) => scrubber.scrub(err instanceof Error ? err.message : String(err));
  const noUsage = (model: string) => ({ model, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 });
  const recordFailure = (jobId: string, kind: "account_check" | "role_session" | "replay", error: string) => {
    try {
      opts.emit({ type: "job_started", jobId, kind });
      opts.emit({ type: "job_finished", jobId, usage: noUsage(opts.agentModelId), stoppedBy: "error", error });
    } catch {
      return;
    }
  };

  for (const ref of new Set(opts.project.personas.flatMap((p) => (p.accountRef ? [p.accountRef] : [])))) {
    if (budget.exceeded) break;
    const jobId = `account:${ref}`;
    const scrubber = scrubberFor();
    const checked = await withBrowser(jobId, scrubber, (b) =>
      checkAccount({ model: opts.agentModel, modelId: opts.agentModelId, project: opts.project, accountRef: ref, browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: Math.min(ACCOUNT_CHECK_STEPS, opts.replaySteps), emit: opts.emit }),
    ).catch((err) => {
      recordFailure(jobId, "account_check", failure(scrubber, err));
      summary.jobs.push({ jobId, ...noUsage(opts.agentModelId) });
      return null;
    });
    if (!checked) continue;
    summary.jobs.push({ jobId, ...checked.usage });
    if (checked.signIn.outcome === "refused") {
      const username = opts.project.accounts.find((a) => a.ref === ref)?.username ?? ref;
      summary.refusedAccount = `The product refused the username and password of ${username}: ${checked.signIn.observed}`;
      summary.totalCostUsd = budget.spent;
      summary.finishedAt = new Date().toISOString();
      return summary;
    }
  }

  const turns = turnsOf(opts.project);
  const teamed = turns.length > opts.project.personas.length;
  const signUpSeed = randomBytes(24).toString("base64url");
  const story: StoryEntry[] = [];
  const byPersona = new Map<string, RoleResult>();
  const seen = opts.secondRound ? seenPages() : null;
  let failedTurn: string | null = null;
  const play = async (session: { persona: Persona; goalIds: string[]; jobId: string; project: ProjectConfig; returning: boolean; secondRound?: boolean }) => {
    const { persona, jobId } = session;
    const scrubber = scrubberFor();
    const told: StoryEntry[] = [];
    const emit = (e: RunEventInput) => {
      if (e.type === "note") told.push({ personaId: persona.id, name: persona.name, text: e.text });
      if (e.type === "goal_status" && e.outcome.status !== "not_attempted") {
        told.push({ personaId: persona.id, name: persona.name, goal: session.project.goals.find((g) => g.id === e.outcome.goal)?.instruction ?? e.outcome.goal, status: e.outcome.status, text: e.outcome.note });
      }
      opts.emit(e);
    };
    const { result, usage } = await withBrowser(jobId, scrubber, (b) =>
      runRoleSession({
        model: opts.agentModel, modelId: opts.agentModelId, persona, project: session.project,
        browserTools: seen ? seen.watch(b.tools, persona.id) : b.tools, fillField: b.fillField, accountForm: b.accountForm?.bind(b), scrubber, budget, maxSteps: opts.maxSteps, emit,
        newFindingId: () => `f${++findingNo}`, pageUrl: () => b.pageUrl(), botProtection: () => b.botProtection?.() ?? null,
        goalIds: session.goalIds, story: trimStory(story), signUpSeed, jobId,
        returning: session.returning,
        ...(opts.look ? { look: true, screenshot: () => b.screenshot() } : {}),
      }),
    ).catch((err): { result: RoleResult; usage: ReturnType<typeof noUsage> } => {
      const error = failure(scrubber, err);
      recordFailure(jobId, "role_session", error);
      return {
        result: { persona: persona.id, goals: session.goalIds.map((goal) => ({ goal, status: "not_attempted", note: "" })), findings: [], stoppedBy: "error", error },
        usage: noUsage(opts.agentModelId),
      };
    });
    story.push(...told);
    const earlier = byPersona.get(persona.id);
    byPersona.set(persona.id, earlier
      ? { ...(session.secondRound ? earlier : result), goals: [...earlier.goals, ...result.goals], findings: [...earlier.findings, ...result.findings] }
      : result);
    summary.jobs.push({ jobId, ...usage });
    return result;
  };
  for (const [i, turn] of turns.entries()) {
    if (budget.exceeded) break;
    const persona = opts.project.personas.find((p) => p.id === turn.personaId)!;
    const jobId = teamed ? `role:${persona.id}#${i + 1}` : `role:${persona.id}`;
    if (teamed && failedTurn) {
      const note = `not started: ${failedTurn} ended in an error, so this turn would have built on what never happened`;
      const skipped: RoleResult = { persona: persona.id, goals: turn.goalIds.map((goal) => ({ goal, status: "not_attempted", note })), findings: [], stoppedBy: "error", error: note };
      const earlier = byPersona.get(persona.id);
      byPersona.set(persona.id, earlier ? { ...earlier, goals: [...earlier.goals, ...skipped.goals] } : skipped);
      continue;
    }
    const result = await play({ persona, goalIds: turn.goalIds, jobId, project: opts.project, returning: turns.slice(0, i).some((t) => t.personaId === persona.id) });
    if (result.stoppedBy === "error") failedTurn = `the turn of ${persona.name} (${jobId})`;
  }

  const notPlayed = !seen ? null
    : budget.exceeded ? "the budget ran out before the second round"
    : teamed && failedTurn ? `${failedTurn} ended in an error, so nobody went on to a second round`
    : seen.pages().length === 0 ? "nobody saw a page to plan it from"
    : null;
  if (notPlayed) summary.secondRound = { goals: [], passedBy: [], sessions: [], error: notPlayed };
  if (seen && !notPlayed) {
    const firstRound = [...byPersona.values()];
    const tell = (e: RunEventInput) => {
      try {
        opts.emit(e);
      } catch {
        return;
      }
    };
    const spentBefore = budget.spent;
    tell({ type: "job_started", jobId: SECOND_ROUND_JOB, kind: "setup" });
    const planned = await planSecondRound({
      model: opts.agentModel, modelId: opts.agentModelId, budget, scrubber: scrubberFor(), project: opts.project,
      outcomes: firstRound.flatMap((r) => r.goals.map((g) => ({ ...g, persona: r.persona }))),
      findings: firstRound.flatMap((r) => r.findings.map((f) => ({ persona: r.persona, kind: f.kind, title: f.title }))),
      pages: seen.pages(), unopened: seen.unopened(),
    }).catch((err) => failure(scrubberFor(), err));
    if (typeof planned === "string") {
      const usage = { ...noUsage(opts.agentModelId), costUsd: Math.max(0, budget.spent - spentBefore) };
      tell({ type: "job_finished", jobId: SECOND_ROUND_JOB, usage, stoppedBy: "error", error: planned.slice(0, MAX_JOB_ERROR) });
      summary.jobs.push({ jobId: SECOND_ROUND_JOB, ...usage });
      summary.secondRound = { goals: [], passedBy: [], sessions: [], error: planned };
    } else {
      const plan = scrubberFor().scrub(planned.plan);
      tell({ type: "job_finished", jobId: SECOND_ROUND_JOB, usage: planned.usage, stoppedBy: "done" });
      summary.jobs.push({ jobId: SECOND_ROUND_JOB, ...planned.usage });
      const sessions: NonNullable<RunSummary["secondRound"]>["sessions"] = [];
      summary.secondRound = { goals: plan.goals, passedBy: plan.passedBy, sessions };
      const project = { ...opts.project, goals: [...opts.project.goals, ...plan.goals] };
      for (const persona of opts.project.personas) {
        const goalIds = plan.goals.filter((g) => g.personaId === persona.id).map((g) => g.id);
        if (goalIds.length === 0) continue;
        if (budget.exceeded) {
          const earlier = byPersona.get(persona.id);
          const goals = goalIds.map((goal) => ({ goal, status: "not_attempted" as const, note: "not started: the budget ran out" }));
          byPersona.set(persona.id, earlier ? { ...earlier, goals: [...earlier.goals, ...goals] } : { persona: persona.id, goals, findings: [], stoppedBy: "budget" });
          continue;
        }
        const result = await play({ persona, goalIds, jobId: `role:${persona.id}#second-round`, project, returning: byPersona.has(persona.id), secondRound: true });
        sessions.push({ persona: persona.id, stoppedBy: result.stoppedBy, ...(result.error ? { error: result.error } : {}) });
      }
    }
  }

  summary.roles.push(...byPersona.values());

  for (const role of summary.roles) {
    const accountRef = opts.project.personas.find((p) => p.id === role.persona)?.accountRef;
    for (const finding of role.findings.filter((f) => f.kind === "defect")) {
      if (budget.exceeded) break;
      const scrubber = scrubberFor();
      const replayed = await withBrowser(`replay:${finding.id}`, scrubber, (b) =>
        runReplay({
          model: opts.agentModel, modelId: opts.agentModelId, finding, project: opts.project, accountRef,
          browserTools: b.tools, fillField: b.fillField, botProtection: () => b.botProtection?.() ?? null, scrubber, budget,
          ...(opts.look ? { look: true, screenshot: () => b.screenshot() } : {}), maxSteps: opts.replaySteps * Math.max(1, new Set(finding.by ?? []).size), emit: opts.emit,
          openBrowser: () => opts.openBrowser({ scrubber, onBlocked: blockedFor(`replay:${finding.id}`, scrubber) }),
        }),
      ).catch((err) => {
        const error = failure(scrubber, err);
        recordFailure(`replay:${finding.id}`, "replay", error);
        summary.replayErrors[finding.id] = error;
        summary.jobs.push({ jobId: `replay:${finding.id}`, ...noUsage(opts.agentModelId) });
        return null;
      });
      if (!replayed) continue;
      const { observation, usage } = replayed;
      summary.jobs.push({ jobId: `replay:${finding.id}`, ...usage });
      summary.replays[finding.id] = observation;
      const wroteNoReport = !observation.completed && observation.blockedAt === null;
      if (wroteNoReport || budget.exceeded) continue;
      const judged = await judge({ model: opts.judgeModel, modelId: opts.judgeModelId, finding, observation, scrubber, budget, emit: opts.emit });
      summary.jobs.push({ jobId: `judge:${finding.id}`, ...judged.usage });
      if (judged.verdict) summary.verdicts[finding.id] = judged.verdict;
      else if (judged.error) summary.judgeErrors[finding.id] = judged.error;
    }
  }

  summary.totalCostUsd = budget.spent;
  summary.finishedAt = new Date().toISOString();
  return summary;
}
