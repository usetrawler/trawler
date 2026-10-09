import type { Database } from "../db/index.ts";
import { withOrg } from "../db/tenancy.ts";
import { projectHead, runCounts, workspaceProjects, workspaceRuns, type RunFilter, type RunLine } from "../projects/overview.ts";
import { listPlans } from "../projects/projects.ts";
import { TRAWLER } from "../runs/dismissals.ts";
import { runView } from "../runs/report.ts";
import { runIdByNumber, runSummary, type RunSummary } from "../runs/runs.ts";
import { runPath } from "../runs/status.ts";
import { personTrail, type TrailEntry } from "../runs/trail.ts";
import { untrusted, type Untrusted } from "./untrusted.ts";

export interface Reach {
  orgId: string;
  projectId: string | null;
}

export const LIMITS = {
  projects: { default: 25, max: 100 },
  runs: { default: 20, max: 50 },
  findingsPerGroup: 25,
  comparedPerList: 25,
  evidenceBytes: 1_000_000,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunRef = number | string;

export const GROUPS = ["confirmed", "inconclusive", "refuted", "couldNotJudge", "notJudged", "friction", "dismissed"] as const;
export type FindingGroup = (typeof GROUPS)[number];

type ReportFinding = ReturnType<typeof runView>["report"][FindingGroup][number];

const iso = (date: Date | null): string | null => (date ? new Date(date).toISOString() : null);

function lineOf(run: RunLine) {
  return {
    id: run.id, number: run.number, status: run.status, createdAt: iso(run.createdAt), project: { id: run.projectId, name: run.projectName },
    plan: run.planName, confirmedDefects: run.confirmed, hasUncheckedDefects: run.unchecked, goalsReached: run.goalsReached, goalsTotal: run.goalsTotal, costUsd: run.costUsd,
  };
}

export async function projectsOf(db: Database, reach: Reach, page: { limit: number; offset: number }) {
  const all = await withOrg(db, reach.orgId, (tx) => workspaceProjects(tx, reach.orgId));
  const visible = reach.projectId ? all.filter((p) => p.id === reach.projectId) : all;
  const shown = visible.slice(page.offset, page.offset + page.limit);
  return {
    projects: shown.map((p) => ({ id: p.id, name: p.name, site: reach.projectId ? null : p.site, targetUrl: p.targetUrl, lastRun: p.lastRun ? lineOf(p.lastRun) : null })),
    nextCursor: page.offset + page.limit < visible.length ? String(page.offset + page.limit) : null,
  };
}

export async function plansOf(db: Database, reach: Reach, projectId: string) {
  if (reach.projectId && reach.projectId !== projectId) return null;
  return withOrg(db, reach.orgId, async (tx) => {
    if (!(await projectHead(tx, reach.orgId, projectId))) return null;
    return (await listPlans(tx, reach.orgId, projectId)).map((p) => ({ id: p.id, name: p.name, features: p.features, people: p.people }));
  });
}

export async function runsOf(db: Database, reach: Reach, options: { projectId?: string; planId?: string; show: RunFilter; before?: number; limit: number }) {
  const projectId = reach.projectId ?? options.projectId;
  if (reach.projectId && options.projectId && options.projectId !== reach.projectId) return null;
  return withOrg(db, reach.orgId, async (tx) => {
    if (projectId && !(await projectHead(tx, reach.orgId, projectId))) return null;
    const [history, counts] = await Promise.all([
      workspaceRuns(tx, reach.orgId, { ...(projectId ? { projectId } : {}), ...(options.planId ? { planId: options.planId } : {}), show: options.show, ...(options.before ? { before: options.before } : {}), size: options.limit }),
      runCounts(tx, reach.orgId, projectId, options.planId),
    ]);
    return { runs: history.runs.map(lineOf), nextBefore: history.olderThan, counts };
  });
}

export async function summaryOf(db: Database, reach: Reach, ref: RunRef): Promise<RunSummary | null> {
  return withOrg(db, reach.orgId, async (tx) => {
    const text = String(ref);
    const id = /^\d{1,9}$/.test(text) ? await runIdByNumber(tx, reach.orgId, Number(text)) : UUID.test(text) ? text.toLowerCase() : null;
    if (!id) return null;
    const summary = await runSummary(tx, reach.orgId, id);
    return summary && (!reach.projectId || summary.projectId === reach.projectId) ? summary : null;
  });
}

const statusOf = (summary: RunSummary) => (summary.cancelReason === "nothing_to_test" ? "skipped" : summary.status);

export type GoalText = string | Untrusted;

const goalOf = (summary: RunSummary, text: string): GoalText => (summary.prPlan ? untrusted("goal written for a pull request", text) : text);
const plainGoal = (goal: GoalText): string => (typeof goal === "string" ? goal : goal.text);

const REFUSED = "The product refused a test account, so the run stopped. Check that account on the plan and run again.";

function headlineOf(summary: RunSummary, headline: string) {
  const refused = summary.status === "cancelled" && summary.cancelReason === "account_refused";
  return { headline: refused ? REFUSED : headline, headlineDetail: refused ? untrusted("what the product said when it refused a test account", headline) : null };
}

const by = (summary: RunSummary, key: string) => summary.personas.find((p) => p.id === key)?.name ?? key;

function findingItem(summary: RunSummary, group: FindingGroup, f: ReportFinding) {
  return {
    key: f.key, group, kind: f.kind, severity: f.severity, verdict: f.verdict ?? null, person: f.personaName, goal: goalOf(summary, f.goalText),
    title: untrusted(`finding title, filed by ${f.personaName}`, f.title),
    evidence: [f.screenshots.reported, f.screenshots.replayed].filter(Boolean).length,
    ...("reason" in f ? { reason: untrusted("why the finding could not be judged", (f as ReportFinding & { reason: string }).reason) } : {}),
  };
}

export function runReport(summary: RunSummary, origin: string) {
  const view = runView(summary);
  const groups = Object.fromEntries(GROUPS.map((group) => {
    const all = view.report[group] as ReportFinding[];
    const items = all.slice(0, LIMITS.findingsPerGroup).map((f) => findingItem(summary, group, f));
    return [group, { total: all.length, items, more: Math.max(0, all.length - items.length) }];
  })) as Record<FindingGroup, { total: number; items: ReturnType<typeof findingItem>[]; more: number }>;
  return {
    id: summary.id, number: summary.number, url: `${origin}${runPath(summary.number)}`, status: statusOf(summary), live: view.live, ...headlineOf(summary, view.headline),
    project: { id: summary.projectId }, plan: summary.planName, target: summary.target, model: summary.agentModel,
    createdAt: iso(summary.createdAt), startedAt: iso(summary.startedAt), finishedAt: iso(summary.finishedAt),
    costUsd: summary.costUsd, budgetUsd: summary.budgetUsd,
    pullRequest: summary.pullRequest ? { number: summary.pullRequest.number, repository: summary.pullRequest.repository, url: summary.pullRequest.url, title: summary.pullRequest.title === null ? null : untrusted("pull request title", summary.pullRequest.title) } : null,
    botProtection: summary.botProtection ? { vendor: summary.botProtection.vendor } : null,
    goals: { reached: view.goalsReached, total: view.goalsTotal, notReached: view.unreachedGoals.map((g) => goalOf(summary, g)) },
    people: view.personas.map((p) => ({
      id: p.id, name: p.name, state: p.state, defects: p.defects, friction: p.friction,
      goals: p.goals.map((g) => ({ id: g.id, goal: goalOf(summary, g.goal), status: g.status, note: g.note ? untrusted(`note by ${p.name} on a goal`, g.note) : null })),
    })),
    findings: groups,
  };
}

export type RunReportView = ReturnType<typeof runReport>;

export type EvidenceRef = { ref: string; kind: "screenshot" | "trail"; label: string };

export function findingDetail(summary: RunSummary, key: string) {
  const view = runView(summary);
  for (const group of GROUPS) {
    for (const f of view.report[group] as ReportFinding[]) {
      const same = f.sameReports.find((s) => s.key === key);
      if (f.key !== key && !same) continue;
      const source = f.key === key ? f : { ...f, ...same! };
      const who = source.personaName;
      const personaOfKey = summary.findings.find((x) => x.key === key)?.personaKey ?? f.personaKey;
      const replay = f.replay as { observed?: string; completed?: boolean } | null;
      const evidence: EvidenceRef[] = [
        ...(source.screenshots.reported ? [{ ref: `shot:${source.screenshots.reported}`, kind: "screenshot" as const, label: `the page when ${who} reported it` }] : []),
        ...(source.screenshots.replayed ? [{ ref: `shot:${source.screenshots.replayed}`, kind: "screenshot" as const, label: "where the replay ended" }] : []),
        { ref: `trail:${personaOfKey}`, kind: "trail" as const, label: `what ${who} did, step by step` },
      ];
      return {
        run: summary.number, key: source.key, group, kind: f.kind, severity: f.severity, verdict: f.verdict ?? null, person: who, goal: goalOf(summary, f.goalText),
        groupedUnder: f.key === key ? null : f.key,
        title: untrusted(`finding title, filed by ${who}`, source.title),
        observed: untrusted(`what ${who} observed`, source.observed),
        reproduction: untrusted(`steps ${who} followed`, (source.reproduction as string[]).map((step, i) => `${i + 1}. ${step}`).join("\n")),
        quote: source.quote ? untrusted(`text of the page quoted by ${who}`, source.quote) : null,
        page: source.page ? untrusted("address of the page", source.page) : null,
        replay: replay ? { completed: replay.completed ?? null, observed: replay.observed ? untrusted("what the replaying agent saw", replay.observed) : null } : null,
        sameReports: f.sameReports.map((s) => ({ key: s.key, title: untrusted(`finding title, filed by ${s.personaName}`, s.title) })),
        dismissal: "dismissal" in f && f.dismissal ? { reason: untrusted("why this finding was marked not a bug", f.dismissal.reason), by: f.dismissal.userId === TRAWLER ? "Trawler" : "a member of the workspace", at: iso(f.dismissal.at) } : null,
        evidence,
      };
    }
  }
  return null;
}

export type FindingDetail = NonNullable<ReturnType<typeof findingDetail>>;

export type ScreenshotFound = { artifactId: string; contentType: string; size: number };

export async function screenshotOf(db: Database, reach: Reach, summary: RunSummary, artifactId: string): Promise<ScreenshotFound | null> {
  if (!UUID.test(artifactId)) return null;
  return withOrg(db, reach.orgId, async (tx) => {
    const row = await tx.selectFrom("artifacts").select(["id", "content_type", "size_bytes"])
      .where("id", "=", artifactId.toLowerCase()).where("org_id", "=", reach.orgId).where("run_id", "=", summary.id).where("kind", "=", "screenshot")
      .where("stored_at", "is not", null).where("discarded_at", "is", null).executeTakeFirst();
    return row ? { artifactId: row.id, contentType: row.content_type, size: row.size_bytes } : null;
  });
}

const CURSOR = /^[1-9]\d{0,14}$/;

const trailLine = (e: TrailEntry): string => {
  switch (e.kind) {
    case "step": return `step ${e.step}${e.tool ? ` ${e.tool}` : ""}${e.page ? ` on ${e.page}` : ""}`;
    case "note": return `note: ${e.text}`;
    case "goal": return `goal ${e.status}: ${e.goal}${e.note ? ` (${e.note})` : ""}`;
    case "finding": return `filed ${e.findingKind}: ${e.title}`;
    case "blocked": return `blocked a request to ${e.address}`;
    case "bot_protection": return `bot protection (${e.vendor})${e.page ? ` on ${e.page}` : ""}`;
  }
};

export async function trailOf(db: Database, reach: Reach, summary: RunSummary, personaKey: string, before?: string) {
  if (before !== undefined && !CURSOR.test(before)) return null;
  const trail = await withOrg(db, reach.orgId, (tx) => personTrail(tx, reach.orgId, summary.id, personaKey, before === undefined ? undefined : Number(before)));
  if (!trail) return null;
  const who = by(summary, personaKey);
  return {
    person: who,
    turns: trail.turns.map((t) => ({ number: t.number, status: t.status, stoppedBy: t.stoppedBy, entries: t.entries })),
    trail: untrusted(`what ${who} did in run ${summary.number}, oldest first`, trail.entries.map((e) => `${e.at} ${trailLine(e)}`).join("\n")),
    entries: trail.entries.length,
    nextBefore: trail.olderThan === null ? null : String(trail.olderThan),
  };
}

type Verdict = "confirmed" | "inconclusive" | "refuted" | "could_not_judge" | "unchecked" | "friction" | "dismissed";
const COMPARED: Array<[FindingGroup, Verdict]> = [["confirmed", "confirmed"], ["inconclusive", "inconclusive"], ["refuted", "refuted"], ["couldNotJudge", "could_not_judge"], ["notJudged", "unchecked"], ["friction", "friction"], ["dismissed", "dismissed"]];
const sameWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function reported(summary: RunSummary) {
  const view = runView(summary);
  return COMPARED.flatMap(([group, verdict]) => (view.report[group] as ReportFinding[]).flatMap((f) => [f, ...f.sameReports.map((s) => ({ ...f, key: s.key, title: s.title }))]
    .map((x) => ({ key: x.key, verdict, goalText: f.goalText, personaKey: f.personaKey, title: x.title, match: `${sameWords(x.title)}|${sameWords(f.goalText)}` }))));
}

type GoalState = "reached" | "failed" | "not_attempted" | "not_tested";

function goalStates(summary: RunSummary): Map<string, { person: string; goal: GoalText; state: GoalState }> {
  const view = runView(summary);
  return new Map(view.personas.flatMap((p) => p.goals.map((g) => [`${p.id}/${sameWords(g.goal)}`, { person: p.name, goal: goalOf(summary, g.goal), state: (g.status ?? "not_tested") as GoalState }] as const)));
}

const checked = (state: GoalState | undefined) => state === "reached" || state === "failed";

function change(base: GoalState | undefined, head: GoalState | undefined): string {
  if (base === head) return "same";
  if (!checked(base) && !checked(head)) return "same_not_checked";
  if (!checked(base)) return "not_checked_in_base";
  if (!checked(head)) return "not_checked_in_head";
  return head === "reached" ? "now_reached" : "regressed";
}

const capped = <T>(items: T[]) => ({ items: items.slice(0, LIMITS.comparedPerList), total: items.length, more: Math.max(0, items.length - LIMITS.comparedPerList) });

export function compareRuns(first: RunSummary, second: RunSummary) {
  const [base, head] = first.number <= second.number ? [first, second] : [second, first];
  const before = goalStates(base);
  const after = goalStates(head);
  const goals = [...new Set([...before.keys(), ...after.keys()])].map((id) => {
    const b = before.get(id);
    const h = after.get(id);
    return { person: (h ?? b)!.person, goal: (h ?? b)!.goal, base: b?.state ?? "not_in_plan", head: h?.state ?? "not_in_plan", change: change(b?.state, h?.state) };
  });
  const inBase = reported(base);
  const inHead = reported(head);
  const matched = new Set<string>();
  const stillReported = inBase.flatMap((b) => {
    const h = inHead.find((x) => x.match === b.match && !matched.has(x.key));
    if (!h) return [];
    matched.add(h.key);
    return [{ title: untrusted("finding title", b.title), goal: goalOf(base, b.goalText), base: { key: b.key, verdict: b.verdict }, head: { key: h.key, verdict: h.verdict }, matchedBy: "same wording of the title and the same goal text" }];
  });
  const paired = new Set(stillReported.map((s) => s.base.key));
  const goalInHead = (personaKey: string, goalText: string) => after.get(`${personaKey}/${sameWords(goalText)}`)?.state ?? "not_in_plan";
  const plansDiffer = base.planName !== head.planName;
  return {
    swapped: base !== first,
    base: { number: base.number, ...headlineOf(base, runView(base).headline), status: statusOf(base) },
    head: { number: head.number, ...headlineOf(head, runView(head).headline), status: statusOf(head) },
    goals,
    findings: {
      stillReported: capped(stillReported),
      onlyInBase: capped(inBase.filter((f) => !paired.has(f.key)).map((f) => ({ key: f.key, verdict: f.verdict, title: untrusted("finding title", f.title), goal: goalOf(base, f.goalText), goalInHead: goalInHead(f.personaKey, f.goalText) }))),
      onlyInHead: capped(inHead.filter((f) => !matched.has(f.key)).map((f) => ({ key: f.key, verdict: f.verdict, title: untrusted("finding title", f.title), goal: goalOf(head, f.goalText) }))),
    },
    caveats: [
      "Findings are matched by the wording of their title and the text of their goal, across confirmed, refuted, unchecked, friction and dismissed reports. Different wording of the same defect shows up as one finding only in the base run and one only in the head run.",
      "A defect that is not reported in the head run is not proven fixed, even when its goal was reached there (goalInHead): reaching the goal says the check ran, not that the defect is gone.",
      "Goals are matched by person and goal text. A goal with no outcome is not tested, which is different from failed.",
      ...(plansDiffer ? ["These runs followed different plans, so goals and findings may not be comparable."] : []),
      ...(base !== first ? ["The runs were given newest first; base is the older run."] : []),
    ],
  };
}

export type { Untrusted };
