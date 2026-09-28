import { goalsFor } from "@usetrawler/protocol";
import { ACCOUNT_REFUSED, type CancelReason, type RunSummary } from "./runs.ts";

export type StageState = "waiting" | "active" | "done" | "skipped";
function useDetail(people: number, turns: number): string {
  if (turns <= people) return `${people} ${people === 1 ? "session" : "sessions"}`;
  return `${people} people taking ${turns} turns`;
}

export type PersonaState = "waiting" | "exploring" | "reached" | "missed" | "finished" | "failed" | "cancelled";
export type JudgeAgainState = "judge_again" | "judging" | "after_run" | "cap_spent";

const OPEN = new Set(["queued", "leased"]);
const LIVE = new Set(["queued", "running"]);

type Job = RunSummary["jobs"][number];

const MODEL_FAULT = /^(the model\b|the provider's content filter\b|No output generated|No object generated)/;
type Finding = RunSummary["findings"][number];

export const isLive = (status: string) => LIVE.has(status);

const RAN = new Set(["succeeded", "failed"]);

function stage(jobs: Job[], runLive: boolean): StageState {
  if (!runLive) return jobs.some((j) => RAN.has(j.status)) ? "done" : "skipped";
  if (jobs.length === 0) return "waiting";
  if (!jobs.some((j) => OPEN.has(j.status))) return "done";
  return jobs.some((j) => j.status !== "queued") ? "active" : "waiting";
}

function replayFailedBecause(job: Job): string {
  const detail = job.error ?? "no reason was recorded";
  return job.stopped_by === "error" && MODEL_FAULT.test(detail) ? `The replay hit a model error: ${detail}` : `The replay failed: ${detail}`;
}

function notJudgedReason(f: Finding, runLive: boolean, failedReplay: Job | undefined): string {
  if (failedReplay) return replayFailedBecause(failedReplay);
  const replay = f.replay as { completed: boolean; blockedAt: number | null } | null;
  if (replay && !replay.completed && replay.blockedAt === null) return "The fresh agent could not follow the steps far enough to report.";
  if (replay) return runLive ? "Waiting for the judge." : "The run ended before it was judged.";
  if (runLive) return "Waiting for its replay.";
  return "The run ended before it was replayed.";
}

export function gaveNoVerdict(job: { status: string; stopped_by: string | null; requested: boolean }, verdict: string | null): boolean {
  if (verdict === "confirmed" || verdict === "refuted") return false;
  if (job.status === "failed") return true;
  return job.status === "succeeded" && job.stopped_by === "budget" && (verdict === null || !job.requested);
}

function whyNotJudged(job: Job, runStatus: string, cancelReason: CancelReason | null, capSpent: boolean): string {
  if (job.status === "failed") {
    const detail = job.error ?? "no reason was recorded";
    return job.stopped_by === "error" && MODEL_FAULT.test(detail) ? `Model error: ${detail}` : `Failed: ${detail}`;
  }
  if (capSpent) return "The run's cap ran out before the judge answered.";
  if (runStatus === "cancelled" && !job.requested) return cancelReason === "key_removed" ? "The model key was removed before the judge answered." : "The run was stopped before the judge answered.";
  return job.error ? `Stopped: ${job.error}` : "The model call was refused before the judge answered.";
}

export function runView(s: RunSummary) {
  const live = isLive(s.status);
  const byKind = (kind: string) => s.jobs.filter((j) => j.kind === kind);
  const lastJudge = (f: Finding) => byKind("judge").filter((j) => j.finding_key === f.key).at(-1);
  const failedReplay = (f: Finding) => {
    const replayJob = byKind("replay").filter((j) => j.finding_key === f.key).at(-1);
    return replayJob?.status === "failed" && !lastJudge(f) ? replayJob : undefined;
  };
  const judgingAgain = (f: Finding) => { const j = lastJudge(f); return !!j && j.requested && OPEN.has(j.status); };
  const unjudged = (f: Finding) => { const j = lastJudge(f); return !!j && gaveNoVerdict(j, f.verdict); };
  const defects = s.findings.filter((f) => f.kind === "defect");
  const rejudging = defects.some(judgingAgain);
  const use = stage(byKind("role_session"), live);
  const replay = stage(byKind("replay"), live);
  const judge = rejudging ? "active" : stage(byKind("judge"), live);
  const stages = [
    { label: "Use", detail: useDetail(s.personas.length, byKind("role_session").length), state: use },
    { label: "Replay", detail: "a fresh agent follows each defect's steps", state: replay },
    { label: "Judge", detail: "compares the replay with the report", state: judge },
    { label: "Report", detail: "", state: (live ? "waiting" : "done") as StageState },
  ];

  const goalText = new Map(s.goalTexts.map((g) => [g.id, g.instruction]));
  const personas = s.personas.map((p) => {
    const turns = s.jobs.filter((j) => j.kind === "role_session" && j.persona_key === p.id);
    const failed = turns.at(-1)?.status === "failed" ? turns.at(-1) : undefined;
    const ended = turns.length > 0 && turns.every((j) => j.status === "succeeded" || j.status === "failed");
    const goals = s.goals.filter((g) => g.personaKey === p.id);
    const findings = s.findings.filter((f) => f.personaKey === p.id);
    const own = goalsFor(s.goalTexts, p.id);
    const reached = goals.filter((g) => g.status === "reached").length;
    let state: PersonaState = "waiting";
    if (live && turns.some((j) => j.status === "leased")) state = "exploring";
    else if (ended && failed) state = "failed";
    else if (ended) state = goals.some((g) => g.status === "failed") ? "missed" : reached === own.length ? "reached" : "finished";
    else if (!live || turns.some((j) => j.status === "cancelled")) state = "cancelled";
    return {
      id: p.id, name: p.name, state, error: failed?.error ?? null,
      hadTurn: turns.some((j) => j.status === "succeeded" || j.status === "failed"),
      goals: own.map((g) => {
        const outcome = goals.find((o) => o.goal === g.id);
        return { id: g.id, goal: g.instruction, status: outcome?.status ?? null, note: outcome?.note ?? "" };
      }),
      defects: findings.filter((f) => f.kind === "defect").length,
      friction: findings.filter((f) => f.kind === "friction").length,
    };
  });

  const name = new Map(s.personas.map((p) => [p.id, p.name]));
  const withPersona = (f: Finding) => ({ ...f, personaName: name.get(f.personaKey) ?? f.personaKey, goalText: goalText.get(f.goal) ?? f.goal, reproduction: f.reproduction as string[] });
  const capSpent = s.costUsd >= s.budgetUsd || (s.tokenCap !== null && s.tokensUsed >= s.tokenCap);
  const unsettled = defects.filter((f) => judgingAgain(f) || unjudged(f));
  const settled = defects.filter((f) => !unsettled.includes(f));
  const report = {
    confirmed: settled.filter((f) => f.verdict === "confirmed").map(withPersona),
    inconclusive: settled.filter((f) => f.verdict === "inconclusive").map(withPersona),
    refuted: settled.filter((f) => f.verdict === "refuted").map(withPersona),
    couldNotJudge: unsettled.map((f) => ({
      ...withPersona(f),
      reason: judgingAgain(f) ? "Judging again…" : whyNotJudged(lastJudge(f)!, s.status, s.cancelReason, capSpent),
      action: (judgingAgain(f) ? "judging" : live ? "after_run" : capSpent ? "cap_spent" : "judge_again") as JudgeAgainState,
    })),
    notJudged: settled.filter((f) => !f.verdict).map((f) => ({ ...withPersona(f), reason: notJudgedReason(f, live, failedReplay(f)) })),
    friction: s.findings.filter((f) => f.kind === "friction").map(withPersona),
  };

  const goalsReached = s.goals.filter((g) => g.status === "reached").length;
  const goalsTotal = s.personas.reduce((sum, p) => sum + goalsFor(s.goalTexts, p.id).length, 0);
  const replaysAllFailed = defects.length > 0 && defects.every((f) => !f.verdict && failedReplay(f));
  return { live, rejudging, stages, personas, report, goalsReached, goalsTotal, headline: headline(s, report.confirmed.length, defects.length, replaysAllFailed) };
}

function headline(s: RunSummary, confirmed: number, defects: number, replaysAllFailed: boolean): string {
  const { status, cancelReason } = s;
  const checks = s.jobs.filter((j) => j.kind === "account_check");
  if (status === "queued") return "Waiting for a runner.";
  if (status === "running") return checks.some((j) => OPEN.has(j.status)) ? "Checking that the test accounts can sign in." : "Your people are using the product.";
  if (status === "cancelled" && cancelReason === "account_refused") {
    const refused = checks.findLast((j) => j.status === "failed" && j.error?.startsWith(ACCOUNT_REFUSED))?.error?.trim() ?? "The product refused a test account";
    return `${/[.!?]$/.test(refused) ? refused : `${refused}.`} Check that account on the plan and run again.`;
  }
  if (status === "cancelled") return cancelReason === "key_removed" ? "Stopped when the model key was removed." : "This run was stopped.";
  if (status === "failed") return "This run could not finish.";
  const prefix = status === "stopped_budget" ? "Stopped at the cap. " : "";
  if (confirmed > 0) return `${prefix}${confirmed} ${confirmed === 1 ? "defect" : "defects"} confirmed by replay.`;
  if (replaysAllFailed) return `${prefix}None of the reported defects could be checked: every replay failed.`;
  if (defects > 0) return `${prefix}None of the reported defects was confirmed.`;
  return `${prefix}No defects found.`;
}
