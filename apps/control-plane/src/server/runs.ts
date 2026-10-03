import { withOrg } from "../db/tenancy.ts";
import { runIdByNumber, runSummary, type RunSummary } from "../runs/runs.ts";
import { TRAWLER } from "../runs/dismissals.ts";
import { getAuth, signedInMember, type Member } from "./auth.ts";
import { getDb } from "./db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_NUMBER = /^\d{1,9}$/;

export type RunAccess = { signedIn: false } | { signedIn: true; member: Member; run: RunSummary | null };

export async function runIdFor(orgId: string, ref: string): Promise<string | null> {
  if (UUID.test(ref)) return ref;
  if (!RUN_NUMBER.test(ref) || Number(ref) < 1) return null;
  return withOrg(getDb(), orgId, (tx) => runIdByNumber(tx, orgId, Number(ref)));
}

async function withDismissersNamed(orgId: string, run: RunSummary): Promise<RunSummary> {
  const ids = [...new Set(run.findings.flatMap((f) => (f.dismissal && f.dismissal.userId !== TRAWLER ? [f.dismissal.userId] : [])))];
  if (ids.length === 0) return run;
  const auth = getAuth();
  const email = new Map(await Promise.all(ids.map(async (id) => [id, await auth.memberEmail(orgId, id)] as const)));
  return { ...run, findings: run.findings.map((f) => (f.dismissal ? { ...f, dismissal: { ...f.dismissal, by: email.get(f.dismissal.userId) ?? null } } : f)) };
}

export async function runFor(requestHeaders: Headers, ref: string): Promise<RunAccess> {
  const member = await signedInMember(requestHeaders);
  if (!member) return { signedIn: false };
  const id = await runIdFor(member.orgId, ref);
  if (!id) return { signedIn: true, member, run: null };
  const run = await withOrg(getDb(), member.orgId, (tx) => runSummary(tx, member.orgId, id));
  return { signedIn: true, member, run: run && (await withDismissersNamed(member.orgId, run)) };
}
