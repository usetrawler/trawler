import { withOrg } from "../db/tenancy.ts";
import { runIdByNumber, runSummary, type RunSummary } from "../runs/runs.ts";
import { signedInMember, type Member } from "./auth.ts";
import { getDb } from "./db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_NUMBER = /^\d{1,9}$/;

export type RunAccess = { signedIn: false } | { signedIn: true; member: Member; run: RunSummary | null };

export async function runIdFor(orgId: string, ref: string): Promise<string | null> {
  if (UUID.test(ref)) return ref;
  if (!RUN_NUMBER.test(ref) || Number(ref) < 1) return null;
  return withOrg(getDb(), orgId, (tx) => runIdByNumber(tx, orgId, Number(ref)));
}

export async function runFor(requestHeaders: Headers, ref: string): Promise<RunAccess> {
  const member = await signedInMember(requestHeaders);
  if (!member) return { signedIn: false };
  const id = await runIdFor(member.orgId, ref);
  if (!id) return { signedIn: true, member, run: null };
  return { signedIn: true, member, run: await withOrg(getDb(), member.orgId, (tx) => runSummary(tx, member.orgId, id)) };
}
