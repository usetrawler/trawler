import { goalsFor } from "@usetrawler/protocol";
import { RUN_TIME_LIMIT_HOURS, UNCLAIMED_RUN_MINUTES } from "./limits.ts";
import { ACCOUNT_REFUSED, outOfBudget, type CancelReason, type RunSummary } from "./runs.ts";
import { NOTHING_TO_TEST, thinCoverage } from "./status.ts";

export type StageState = "waiting" | "active" | "done" | "skipped";
function useDetail(people: number, turns: number): string {
  if (turns <= people) return `${people} ${people === 1 ? "session" : "sessions"}`;
  return `${people} people taking ${turns} turns`;
}

export type PersonaState = "waiting" | "exploring" | "standby" | "reached" | "missed" | "finished" | "failed" | "cancelled";
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

function notJudgedReason(f: Finding, runLive: boolean, failedReplay: Job | undefined, grouping: boolean, soleDefect: boolean): string {
  if (failedReplay) return replayFailedBecause(failedReplay);
  if (grouping && f.filedAs !== "friction") return soleDefect ? "Checking it against the findings marked not a bug." : "Checking whether others found the same defect.";
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

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
const worst = (reports: Finding[]) => reports.reduce((top, f) => ((SEVERITY_RANK[f.severity] ?? 0) > (SEVERITY_RANK[top] ?? 0) ? f.severity : top), reports[0]!.severity);

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
  const defects = s.findings.filter((f) => f.kind === "defect" && !f.sameAs && !f.dismissal);
  const dismissed = s.findings.filter((f) => !f.sameAs && f.dismissal);
  const candidatesToJudge = s.findings.filter((f) => f.filedAs === "friction" && f.kind === "friction" && !f.sameAs && !f.dismissal && (judgingAgain(f) || unjudged(f)));
  const rejudging = [...defects, ...candidatesToJudge].some(judgingAgain);
  const use = stage(byKind("role_session"), live);
  const grouping = live && byKind("group").some((j) => OPEN.has(j.status));
  const replay = grouping ? "active" : stage(byKind("replay"), live);
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
    if (live && turns.some((j) => j.status === "leased")) state = turns.some((j) => j.status === "leased" && j.on_standby) ? "standby" : "exploring";
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
  const reported = (f: Finding) => ({ personaName: name.get(f.personaKey) ?? f.personaKey, goalText: goalText.get(f.goal) ?? f.goal, reproduction: stepsWithPeople(f.reproduction as string[], f.stepPeople ?? null, name), page: pageLabel(f.url, s.target), quote: f.quote });
  const withPersona = (f: Finding) => {
    const same = s.findings.filter((other) => other.sameAs === f.key);
    return {
    ...f, ...reported(f), severity: worst([f, ...same]), replayedAsDefect: f.filedAs === "friction" && (f.verdict === "confirmed" || candidatesToJudge.includes(f)),
      sameReports: same.map((other) => ({ key: other.key, title: other.title, observed: other.observed, screenshots: other.screenshots, ...reported(other) })),
    };
  };
  const capSpent = outOfBudget(s);
  const unsettled = s.findings.filter((f) => candidatesToJudge.includes(f) || (defects.includes(f) && (judgingAgain(f) || unjudged(f))));
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
    notJudged: settled.filter((f) => !f.verdict).map((f) => ({ ...withPersona(f), reason: notJudgedReason(f, live, failedReplay(f), grouping, defects.filter((d) => d.filedAs !== "friction").length === 1) })),
    friction: s.findings.filter((f) => f.kind === "friction" && !f.dismissal && !candidatesToJudge.includes(f)).map(withPersona),
    dismissed: dismissed.map((f) => ({ ...withPersona(f), dismissal: f.dismissal! })),
  };

  const goalsReached = s.goals.filter((g) => g.status === "reached").length;
  const goalsTotal = s.personas.reduce((sum, p) => sum + goalsFor(s.goalTexts, p.id).length, 0);
  const unreachedGoals = s.goalTexts.filter((t) => !s.goals.some((g) => g.goal === t.id && g.status === "reached")).map((t) => t.instruction);
  const replaysAllFailed = defects.length > 0 && defects.every((f) => failedReplay(f));
  const refreshes = live || s.jobs.some((j) => j.status === "leased" || (j.status === "queued" && j.requested));
  return { live, rejudging, refreshes, stages, personas, report, reported: defects.length, goalsReached, goalsTotal, unreachedGoals, headline: headline(s, report.confirmed.length, defects.length, replaysAllFailed, dismissed.some((f) => f.kind === "defect"), goalsReached, goalsTotal) };
}

const STOPPED_BECAUSE: Record<CancelReason, string> = {
  stopped: "This run was stopped.",
  key_removed: "Stopped when the model key was removed.",
  account_refused: "Stopped when the product refused a test account.",
  time_limit: `Stopped after ${RUN_TIME_LIMIT_HOURS} hours, the longest a run may take.`,
  workspace_budget: "Stopped when the workspace reached its monthly budget.",
  paused: "Stopped when runs on this project were paused.",
  halted: "Stopped because Trawler paused hosted runs.",
  stopped_from_ci: "Stopped from CI: the job timed out, was cancelled or was interrupted before the run finished.",
  unclaimed: `No runner picked this run up within ${UNCLAIMED_RUN_MINUTES} minutes, so it was stopped.`,
  ci_gone: "The CI job that started this run stopped asking about it, so the run was stopped.",
  superseded: "A newer push to the same pull request started another run, so this one was stopped.",
  nothing_to_test: NOTHING_TO_TEST,
};

function headline(s: RunSummary, confirmed: number, defects: number, replaysAllFailed: boolean, defectsDismissed: boolean, goalsReached: number, goalsTotal: number): string {
  const { status, cancelReason } = s;
  const checks = s.jobs.filter((j) => j.kind === "account_check");
  if (status === "queued") return "Waiting for a runner.";
  if (status === "running") return checks.some((j) => OPEN.has(j.status)) ? "Checking that the test accounts can sign in." : "Your people are using the product.";
  if (status === "cancelled" && cancelReason === "account_refused") {
    const refused = checks.findLast((j) => j.status === "failed" && j.error?.startsWith(ACCOUNT_REFUSED))?.error?.trim() ?? "The product refused a test account";
    return `${/[.!?]$/.test(refused) ? refused : `${refused}.`} Check that account on the plan and run again.`;
  }
  if (status === "cancelled") return STOPPED_BECAUSE[cancelReason ?? "stopped"];
  if (status === "failed") return "This run could not finish.";
  const prefix = status === "stopped_budget" ? "Stopped at the cap. " : "";
  if (confirmed > 0) return `${prefix}${confirmed} ${confirmed === 1 ? "defect" : "defects"} confirmed by replay.`;
  if (replaysAllFailed) return `${prefix}None of the reported defects could be checked: every replay failed.`;
  if (defects > 0) return `${prefix}None of the reported defects was confirmed.`;
  if (defectsDismissed) return `${prefix}Every reported defect was marked not a bug.`;
  if (thinCoverage(goalsReached, goalsTotal)) return `${prefix}No defects found, but only ${goalsReached} of ${goalsTotal} goals were reached, so this run cannot say the change works.`;
  return `${prefix}No defects found.`;
}

function readable(address: string): string {
  try {
    return decodeURI(address);
  } catch {
    return address;
  }
}

function readableQuery(search: string): string {
  if (!search) return "";
  return `?${search.slice(1).split("&").map((part) => {
    try {
      return decodeURIComponent(part.replace(/\+/g, " "));
    } catch {
      return part;
    }
  }).join("&")}`;
}

export function pageLabel(url: string | null, target: string): string | null {
  if (!url || !URL.canParse(url)) return null;
  const page = new URL(url);
  const where = `${readable(page.pathname)}${readableQuery(page.search)}`;
  return URL.canParse(target) && new URL(target).host === page.host ? where : `${page.host}${where}`;
}

export function stepsWithPeople(steps: string[], by: string[] | null, name: Map<string, string>): string[] {
  if (!by || by.length !== steps.length) return steps;
  return steps.map((step, i) => `${name.get(by[i]!) ?? by[i]}: ${step}`);
}
