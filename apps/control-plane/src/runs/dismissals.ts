import { MAX_NOT_BUG_REASON, MAX_NOT_BUG_TITLE, MAX_NOT_BUGS, type NotABug } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";
import { isLive } from "./report.ts";

export class CannotDismiss extends Error {
  constructor(message: string, readonly why: "reason" | "settled" | "other" = "other") {
    super(message);
  }
}

export function dismissalReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  return reason.length >= 1 && reason.length <= MAX_NOT_BUG_REASON ? reason : null;
}

export async function dismissFinding(tx: Tx, orgId: string, runId: string, findingKey: string, rawReason: unknown, userId: string): Promise<void> {
  const reason = dismissalReason(rawReason);
  if (!reason) throw new CannotDismiss(`Say why it is not a bug, in at most ${MAX_NOT_BUG_REASON} characters.`, "reason");
  const run = await tx.selectFrom("runs").select("status").where("id", "=", runId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!run) throw new CannotDismiss("This run was not found.");
  const working = await tx.selectFrom("jobs").select("id").where("run_id", "=", runId).where("status", "in", ["queued", "leased"]).executeTakeFirst();
  if (isLive(run.status) || working) throw new CannotDismiss("Trawler is still working on this run. You can mark a finding not a bug once it has finished.");
  const finding = await tx.selectFrom("findings").select("same_as").where("run_id", "=", runId).where("key", "=", findingKey).executeTakeFirst();
  if (!finding || finding.same_as !== null) throw new CannotDismiss("This finding was not found.");
  const added = await tx
    .insertInto("finding_dismissals")
    .values({ org_id: orgId, run_id: runId, finding_key: findingKey, reason, dismissed_by: userId })
    .onConflict((oc) => oc.columns(["run_id", "finding_key"]).doNothing())
    .executeTakeFirst();
  if (Number(added.numInsertedOrUpdatedRows ?? 0) === 0) throw new CannotDismiss("It is already marked not a bug.", "settled");
}

export async function undoDismissal(tx: Tx, orgId: string, runId: string, findingKey: string): Promise<void> {
  const removed = await tx.deleteFrom("finding_dismissals").where("org_id", "=", orgId).where("run_id", "=", runId).where("finding_key", "=", findingKey).executeTakeFirst();
  if (Number(removed.numDeletedRows) === 0) throw new CannotDismiss("It is no longer marked not a bug.", "settled");
}

export const TRAWLER = "trawler";

const notBugRef = (runId: string, findingKey: string) => `${runId}/${findingKey}`;

export async function markKnownNotBugs(tx: Tx, run: { orgId: string; runId: string; projectId: string }, matches: Array<{ key: string; ref: string }>): Promise<void> {
  for (const { key, ref } of matches) {
    const slash = ref.indexOf("/");
    if (slash < 1) continue;
    const source = await tx
      .selectFrom("finding_dismissals as d")
      .innerJoin("runs as r", "r.id", "d.run_id")
      .select(["d.run_id", "d.finding_key", "d.reason"])
      .where("d.org_id", "=", run.orgId)
      .where("r.project_id", "=", run.projectId)
      .where("d.run_id", "=", ref.slice(0, slash))
      .where("d.finding_key", "=", ref.slice(slash + 1))
      .where("d.matched_run_id", "is", null)
      .executeTakeFirst();
    if (!source || source.run_id === run.runId) continue;
    await tx
      .insertInto("finding_dismissals")
      .values({ org_id: run.orgId, run_id: run.runId, finding_key: key, reason: source.reason, dismissed_by: TRAWLER, matched_run_id: source.run_id, matched_finding_key: source.finding_key })
      .onConflict((oc) => oc.columns(["run_id", "finding_key"]).doNothing())
      .execute();
  }
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, "");

export async function notBugsOf(tx: Tx, orgId: string, projectId: string): Promise<NotABug[]> {
  const newest = tx
    .selectFrom("finding_dismissals as d")
    .innerJoin("runs as r", "r.id", "d.run_id")
    .innerJoin("findings as f", (j) => j.onRef("f.run_id", "=", "d.run_id").onRef("f.key", "=", "d.finding_key"))
    .select(["f.title", "d.reason", "d.run_id", "d.finding_key", "d.dismissed_at"])
    .distinctOn(["f.title", "d.reason"])
    .where("d.org_id", "=", orgId)
    .where("r.project_id", "=", projectId)
    .where("d.matched_run_id", "is", null)
    .orderBy("f.title")
    .orderBy("d.reason")
    .orderBy("d.dismissed_at", "desc")
    .as("n");
  const rows = await tx.selectFrom(newest).selectAll().orderBy("dismissed_at", "desc").orderBy("title").limit(MAX_NOT_BUGS).execute();
  return rows.map((r) => ({ title: oneLine(r.title, MAX_NOT_BUG_TITLE), reason: oneLine(r.reason, MAX_NOT_BUG_REASON), ref: notBugRef(r.run_id, r.finding_key) }));
}
