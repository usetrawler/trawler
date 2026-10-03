import type { RunEvent } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";
import { pageLabel } from "./report.ts";
import type { ConfigSnapshot } from "./runs.ts";

export const TRAIL_PAGE = 60;
const TRAIL_TYPES = ["step", "note", "goal_status", "finding", "blocked_request", "bot_protection"] as const;

export type TrailEntry = { id: number; turn: string; at: string } & (
  | { kind: "step"; step: number; tool: string | null; page: string | null }
  | { kind: "note"; text: string }
  | { kind: "goal"; status: "reached" | "failed" | "not_attempted"; goal: string; note: string }
  | { kind: "finding"; findingKind: "defect" | "friction"; title: string }
  | { kind: "blocked"; address: string }
  | { kind: "bot_protection"; vendor: string; page: string | null }
);

export interface TrailTurn {
  id: string;
  number: number;
  status: string;
  stoppedBy: string | null;
  error: string | null;
  entries: number;
}

export interface Trail {
  turns: TrailTurn[];
  entries: TrailEntry[];
  olderThan: number | null;
}

const hostOf = (address: string) => (URL.canParse(address) ? new URL(address).host : address);
const withoutQuery = (address: string) => (URL.canParse(address) ? `${new URL(address).origin}${new URL(address).pathname}` : null);

function entryOf(row: { id: string; job_id: string; at: Date; payload: unknown }, target: string, goalText: Map<string, string>): TrailEntry | null {
  const e = row.payload as RunEvent;
  const base = { id: Number(row.id), turn: row.job_id, at: new Date(row.at).toISOString() };
  switch (e.type) {
    case "step": return { ...base, kind: "step", step: e.step, tool: e.tool, page: pageLabel(e.url ?? null, target) };
    case "note": return { ...base, kind: "note", text: e.text };
    case "goal_status": return { ...base, kind: "goal", status: e.outcome.status, goal: goalText.get(e.outcome.goal) ?? e.outcome.goal, note: e.outcome.note ?? "" };
    case "finding": return { ...base, kind: "finding", findingKind: e.finding.kind, title: e.finding.title };
    case "blocked_request": return { ...base, kind: "blocked", address: hostOf(e.url) };
    case "bot_protection": return { ...base, kind: "bot_protection", vendor: e.vendor, page: pageLabel(withoutQuery(e.url), target) };
    default: return null;
  }
}

export async function personTrail(tx: Tx, orgId: string, runId: string, personaKey: string, before?: number): Promise<Trail | null> {
  const run = await tx.selectFrom("runs").select("config_snapshot").where("id", "=", runId).where("org_id", "=", orgId).executeTakeFirst();
  if (!run) return null;
  const snapshot = run.config_snapshot as unknown as ConfigSnapshot;
  if (!snapshot.personas.some((p) => p.id === personaKey)) return null;
  const jobs = await tx
    .selectFrom("jobs")
    .select(["id", "status", "stopped_by", "error"])
    .where("run_id", "=", runId)
    .where("kind", "=", "role_session")
    .where("persona_key", "=", personaKey)
    .orderBy("position")
    .execute();
  if (jobs.length === 0) return { turns: [], entries: [], olderThan: null };
  const jobIds = jobs.map((j) => j.id);
  const events = () => tx.selectFrom("run_events").where("run_id", "=", runId).where("job_id", "in", jobIds).where("type", "in", [...TRAIL_TYPES]);
  const [counts, rows] = await Promise.all([
    events().select(["job_id", (eb) => eb.fn.countAll<string>().as("n")]).groupBy("job_id").execute(),
    (before === undefined ? events() : events().where("id", "<", String(before))).select(["id", "job_id", "at", "payload"]).orderBy("id", "desc").limit(TRAIL_PAGE + 1).execute(),
  ]);
  const count = new Map(counts.map((c) => [c.job_id, Number(c.n)]));
  const goalText = new Map(snapshot.goals.map((g) => [g.id, g.instruction]));
  const page = rows.slice(0, TRAIL_PAGE).reverse();
  return {
    turns: jobs.map((j, i) => ({ id: j.id, number: i + 1, status: j.status, stoppedBy: j.stopped_by, error: j.error, entries: count.get(j.id) ?? 0 })),
    entries: page.flatMap((row) => entryOf(row, snapshot.targetUrl, goalText) ?? []),
    olderThan: rows.length > TRAIL_PAGE ? Number(page[0]!.id) : null,
  };
}
