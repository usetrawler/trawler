import { randomBytes } from "node:crypto";
import type { LanguageModel } from "ai";
import { Budget, checkAccount, judge, runReplay, runRoleSession, SecretScrubber, type Browser } from "@usetrawler/core";
import { ACCOUNT_CHECK_STEPS, MAX_URL, trimStory, turnsOf, type ProjectConfig, type RoleResult, type RunEventInput, type StoryEntry } from "@usetrawler/protocol";
import type { RunSummary } from "./run-dir.ts";

const CLOSE_TIMEOUT_MS = 10_000;

export type OpenBrowser = (opts: { onBlocked: (url: string) => void; scrubber: SecretScrubber }) => Promise<Browser>;

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
}): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const budget = new Budget(opts.budgetUsd);
  const summary: RunSummary = {
    project: opts.project.name, agentModel: opts.agentModelId, judgeModel: opts.judgeModelId,
    startedAt, finishedAt: startedAt, budgetUsd: opts.budgetUsd, totalCostUsd: 0, jobs: [], roles: [], replays: {}, replayErrors: {}, verdicts: {}, judgeErrors: {},
    people: Object.fromEntries(opts.project.personas.map((p) => [p.id, p.name])),
  };
  const scrubberFor = () => SecretScrubber.forProject(opts.project);
  let findingNo = 0;

  const withBrowser = async <T>(jobId: string, scrubber: SecretScrubber, fn: (b: Browser) => Promise<T>): Promise<T> => {
    const onBlocked = (url: string) => {
      try {
        opts.emit(scrubber.scrub({ type: "blocked_request", jobId, url: url.slice(0, MAX_URL) }));
      } catch {
        return;
      }
    };
    const browser = await opts.openBrowser({ onBlocked, scrubber });
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
  for (const [i, turn] of turns.entries()) {
    if (budget.exceeded) break;
    const persona = opts.project.personas.find((p) => p.id === turn.personaId)!;
    const jobId = teamed ? `role:${persona.id}#${i + 1}` : `role:${persona.id}`;
    const scrubber = scrubberFor();
    const told: StoryEntry[] = [];
    const emit = (e: RunEventInput) => {
      if (e.type === "note") told.push({ personaId: persona.id, name: persona.name, text: e.text });
      if (e.type === "goal_status" && e.outcome.status !== "not_attempted") {
        told.push({ personaId: persona.id, name: persona.name, goal: opts.project.goals.find((g) => g.id === e.outcome.goal)?.instruction ?? e.outcome.goal, status: e.outcome.status, text: e.outcome.note });
      }
      opts.emit(e);
    };
    const { result, usage } = await withBrowser(jobId, scrubber, (b) =>
      runRoleSession({
        model: opts.agentModel, modelId: opts.agentModelId, persona, project: opts.project,
        browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: opts.maxSteps, emit,
        newFindingId: () => `f${++findingNo}`, pageUrl: () => b.pageUrl(), botProtection: () => b.botProtection?.() ?? null,
        goalIds: turn.goalIds, story: trimStory(story), signUpSeed, jobId,
        returning: turns.slice(0, i).some((t) => t.personaId === persona.id),
      }),
    ).catch((err): { result: RoleResult; usage: ReturnType<typeof noUsage> } => {
      const error = failure(scrubber, err);
      recordFailure(jobId, "role_session", error);
      return {
        result: { persona: persona.id, goals: turn.goalIds.map((goal) => ({ goal, status: "not_attempted", note: "" })), findings: [], stoppedBy: "error", error },
        usage: noUsage(opts.agentModelId),
      };
    });
    story.push(...told);
    const earlier = byPersona.get(persona.id);
    byPersona.set(persona.id, earlier
      ? { ...result, goals: [...earlier.goals, ...result.goals], findings: [...earlier.findings, ...result.findings] }
      : result);
    summary.jobs.push({ jobId, ...usage });
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
          browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: opts.replaySteps * Math.max(1, new Set(finding.by ?? []).size), emit: opts.emit,
          openBrowser: () => opts.openBrowser({ scrubber, onBlocked: (url) => { try { opts.emit(scrubber.scrub({ type: "blocked_request", jobId: `replay:${finding.id}`, url: url.slice(0, MAX_URL) })); } catch { return; } } }),
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
