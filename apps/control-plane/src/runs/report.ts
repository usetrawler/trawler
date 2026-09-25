import type { RunSummary } from "./runs.ts";

export type StageState = "waiting" | "active" | "done" | "skipped";
export type PersonaState = "waiting" | "exploring" | "reached" | "missed" | "finished" | "failed" | "cancelled";
export type JudgeAgainState = "judge_again" | "judging" | "after_run";

const OPEN = new Set(["queued", "leased"]);
const LIVE = new Set(["queued", "running"]);

type Job = RunSummary["jobs"][number];
type Finding = RunSummary["findings"][number];

export const isLive = (status: string) => LIVE.has(status);

const RAN = new Set(["succeeded", "failed"]);

function stage(jobs: Job[], runLive: boolean): StageState {
  if (!runLive) return jobs.some((j) => RAN.has(j.status)) ? "done" : "skipped";
  if (jobs.length === 0) return "waiting";
  if (!jobs.some((j) => OPEN.has(j.status))) return "done";
  return jobs.some((j) => j.status !== "queued") ? "active" : "waiting";
}

function notJudgedReason(f: Finding, runLive: boolean): string {
  const replay = f.replay as { completed: boolean; blockedAt: number | null } | null;
  if (replay && !replay.completed && replay.blockedAt === null) return "The fresh agent could not follow the steps far enough to report.";
  if (replay) return runLive ? "Waiting for the judge." : "The run ended before it was judged.";
  if (runLive) return "Waiting for its replay.";
  return "The run ended before it was replayed.";
}

function judgeFailure(job: Job): string {
  const detail = job.error ?? "no reason was recorded";
  return job.stopped_by === "error" ? `Model error: ${detail}` : `Failed: ${detail}`;
}

export function runView(s: RunSummary) {
  const live = isLive(s.status);
  const byKind = (kind: string) => s.jobs.filter((j) => j.kind === kind);
  const use = stage(byKind("role_session"), live);
  const replay = stage(byKind("replay"), live);
  const judge = stage(byKind("judge"), live);
  const stages = [
    { label: "Use", detail: `${s.personas.length} ${s.personas.length === 1 ? "session" : "sessions"}`, state: use },
    { label: "Replay", detail: "a fresh agent follows each defect's steps", state: replay },
    { label: "Judge", detail: "compares the replay with the report", state: judge },
    { label: "Report", detail: "", state: (live ? "waiting" : "done") as StageState },
  ];

  const goalText = new Map(s.goalTexts.map((g) => [g.id, g.instruction]));
  const personas = s.personas.map((p) => {
    const job = s.jobs.find((j) => j.kind === "role_session" && j.persona_key === p.id);
    const goals = s.goals.filter((g) => g.personaKey === p.id);
    const findings = s.findings.filter((f) => f.personaKey === p.id);
    const reached = goals.filter((g) => g.status === "reached").length;
    let state: PersonaState = "waiting";
    if (job?.status === "failed") state = "failed";
    else if (job?.status === "succeeded") state = goals.some((g) => g.status === "failed") ? "missed" : reached === s.goalTexts.length ? "reached" : "finished";
    else if (!live || job?.status === "cancelled") state = "cancelled";
    else if (job?.status === "leased") state = "exploring";
    return {
      id: p.id, name: p.name, state, error: job?.error ?? null,
      goals: s.goalTexts.map((g) => {
        const outcome = goals.find((o) => o.goal === g.id);
        return { id: g.id, goal: g.instruction, status: outcome?.status ?? null, note: outcome?.note ?? "" };
      }),
      defects: findings.filter((f) => f.kind === "defect").length,
      friction: findings.filter((f) => f.kind === "friction").length,
    };
  });

  const name = new Map(s.personas.map((p) => [p.id, p.name]));
  const withPersona = (f: Finding) => ({ ...f, personaName: name.get(f.personaKey) ?? f.personaKey, goalText: goalText.get(f.goal) ?? f.goal, reproduction: f.reproduction as string[] });
  const lastJudge = (f: Finding) => s.jobs.filter((j) => j.kind === "judge" && j.finding_key === f.key).at(-1);
  const judgingAgain = (f: Finding) => !live && OPEN.has(lastJudge(f)?.status ?? "");
  const judgeFailed = (f: Finding) => lastJudge(f)?.status === "failed";
  const defects = s.findings.filter((f) => f.kind === "defect");
  const unsettled = defects.filter((f) => judgeFailed(f) || judgingAgain(f));
  const settled = defects.filter((f) => !unsettled.includes(f));
  const report = {
    confirmed: settled.filter((f) => f.verdict === "confirmed").map(withPersona),
    inconclusive: settled.filter((f) => f.verdict === "inconclusive").map(withPersona),
    refuted: settled.filter((f) => f.verdict === "refuted").map(withPersona),
    couldNotJudge: unsettled.map((f) => ({
      ...withPersona(f),
      reason: judgingAgain(f) ? "Judging again…" : judgeFailure(lastJudge(f)!),
      action: (judgingAgain(f) ? "judging" : live ? "after_run" : "judge_again") as JudgeAgainState,
    })),
    notJudged: settled.filter((f) => !f.verdict).map((f) => ({ ...withPersona(f), reason: notJudgedReason(f, live) })),
    friction: s.findings.filter((f) => f.kind === "friction").map(withPersona),
  };

  const goalsReached = s.goals.filter((g) => g.status === "reached").length;
  const goalsTotal = s.personas.length * s.goalTexts.length;
  return { live, rejudging: defects.some(judgingAgain), stages, personas, report, goalsReached, goalsTotal, headline: headline(s.status, report.confirmed.length, defects.length) };
}

function headline(status: string, confirmed: number, defects: number): string {
  if (status === "queued") return "Waiting for a runner.";
  if (status === "running") return "Your people are using the product.";
  if (status === "cancelled") return "You stopped this run.";
  if (status === "failed") return "This run could not finish.";
  const prefix = status === "stopped_budget" ? "Stopped at the cap. " : "";
  if (confirmed > 0) return `${prefix}${confirmed} ${confirmed === 1 ? "defect" : "defects"} confirmed by replay.`;
  if (defects > 0) return `${prefix}None of the reported defects was confirmed.`;
  return `${prefix}No defects found.`;
}
