import { withOrg } from "../db/tenancy.ts";
import { runSummary, type RunSummary } from "../runs/runs.ts";
import { signedInMember, type Member } from "./auth.ts";
import { getDb } from "./db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RunAccess = { signedIn: false } | { signedIn: true; member: Member; run: RunSummary | null };

export async function runFor(requestHeaders: Headers, id: string): Promise<RunAccess> {
  const member = await signedInMember(requestHeaders);
  if (!member) return { signedIn: false };
  if (!UUID.test(id)) return { signedIn: true, member, run: null };
  return { signedIn: true, member, run: await withOrg(getDb(), member.orgId, (tx) => runSummary(tx, member.orgId, id)) };
}
