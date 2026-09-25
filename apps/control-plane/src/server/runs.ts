import { withOrg } from "../db/tenancy.ts";
import { runSummary, type RunSummary } from "../runs/runs.ts";
import { getAuth } from "./auth.ts";
import { getDb } from "./db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RunAccess = { signedIn: false } | { signedIn: true; orgId: string; email: string; userId: string; run: RunSummary | null };

export async function runFor(requestHeaders: Headers, id: string): Promise<RunAccess> {
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return { signedIn: false };
  const orgId = session.session.activeOrganizationId;
  const member = { signedIn: true as const, orgId: orgId ?? "", email: session.user.email, userId: session.user.id };
  if (!orgId || !UUID.test(id)) return { ...member, run: null };
  return { ...member, run: await withOrg(getDb(), orgId, (tx) => runSummary(tx, orgId, id)) };
}
