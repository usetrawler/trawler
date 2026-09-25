import type { RunSummary } from "./runs.ts";

export type StageState = "waiting" | "active" | "done" | "skipped";
export type PersonaState = "waiting" | "exploring" | "reached" | "missed" | "finished" | "failed" | "cancelled";

const OPEN = new Set(["queued", "leased"]);
const LIVE = new Set(["queued", "running"]);

type Job = RunSummary["jobs"][number];
type Finding = RunSummary["findings"][number];

export const isLive = (status: string) => LIVE.has(status);

function stage(jobs: Job[], runLive: boolean): StageState {
  if (jobs.length === 0) return runLive ? "waiting" : "skipped";
  if (!jobs.some((j) => OPEN.has(j.status))) return "done";
  return jobs.some((j) => j.status !== "queued") ? "active" : "waiting";
}

function notJudgedReason(f: Finding, runLive: boolean): string {
  const replay = f.replay as { completed: boolean; blockedAt: number | null } | null;
  if (replay && !replay.completed && replay.blockedAt === null) return "The fresh agent could not follow the steps far enough to report.";
  if (runLive) return "Waiting for its replay.";
  return "The run ended before it was replayed.";
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
    let state: PersonaState = "waiting";
    if (job?.status === "leased") state = "exploring";
    else if (job?.status === "failed") state = "failed";
    else if (job?.status === "cancelled" || (job?.status === "queued" && !live)) state = "cancelled";
    else if (job?.status === "succeeded") state = goals.some((g) => g.status === "failed") ? "missed" : goals.length > 0 ? "reached" : "finished";
    return {
      id: p.id, name: p.name, state, error: job?.error ?? null,
      goals: goals.map((g) => ({ goal: goalText.get(g.goal) ?? g.goal, status: g.status, note: g.note })),
      defects: findings.filter((f) => f.kind === "defect").length,
      friction: findings.filter((f) => f.kind === "friction").length,
    };
  });

  const name = new Map(s.personas.map((p) => [p.id, p.name]));
  const withPersona = (f: Finding) => ({ ...f, personaName: name.get(f.personaKey) ?? f.personaKey, goalText: goalText.get(f.goal) ?? f.goal, reproduction: f.reproduction as string[] });
  const defects = s.findings.filter((f) => f.kind === "defect");
  const report = {
    confirmed: defects.filter((f) => f.verdict === "confirmed").map(withPersona),
    inconclusive: defects.filter((f) => f.verdict === "inconclusive").map(withPersona),
    refuted: defects.filter((f) => f.verdict === "refuted").map(withPersona),
    notJudged: defects.filter((f) => !f.verdict).map((f) => ({ ...withPersona(f), reason: notJudgedReason(f, live) })),
    friction: s.findings.filter((f) => f.kind === "friction").map(withPersona),
  };

  const goalsReached = s.goals.filter((g) => g.status === "reached").length;
  const goalsTotal = s.personas.length * s.goalTexts.length;
  return { live, stages, personas, report, goalsReached, goalsTotal, headline: headline(s.status, report.confirmed.length, defects.length) };
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
