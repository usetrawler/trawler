import { withOrg } from "../db/tenancy.ts";
import { runSummary, type RunSummary } from "../runs/runs.ts";
import { signedInMember } from "./auth.ts";
import { getDb } from "./db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RunAccess = { signedIn: false } | { signedIn: true; orgId: string; email: string; userId: string; run: RunSummary | null };

export async function runFor(requestHeaders: Headers, id: string): Promise<RunAccess> {
  const member = await signedInMember(requestHeaders);
  if (!member) return { signedIn: false };
  const { orgId } = member;
  const access = { signedIn: true as const, orgId, email: member.email, userId: member.userId };
  if (!UUID.test(id)) return { ...access, run: null };
  return { ...access, run: await withOrg(getDb(), orgId, (tx) => runSummary(tx, orgId, id)) };
}
