"use server";
import { headers } from "next/headers";
import { withOrg } from "../../../db/tenancy.ts";
import { cancelRun } from "../../../runs/runs.ts";
import { getAuth } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function cancelRunAction(runId: string): Promise<boolean> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const orgId = session?.session.activeOrganizationId;
  if (!orgId || !UUID.test(runId)) return false;
  try {
    await withOrg(getDb(), orgId, (tx) => cancelRun(tx, orgId, runId));
    return true;
  } catch {
    return false;
  }
}
