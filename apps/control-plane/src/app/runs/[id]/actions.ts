"use server";
import { headers } from "next/headers";
import { withOrg } from "../../../db/tenancy.ts";
import { cancelRun } from "../../../runs/runs.ts";
import { getDb } from "../../../server/db.ts";
import { runFor } from "../../../server/runs.ts";

export async function cancelRunAction(runId: string): Promise<void> {
  const access = await runFor(await headers(), runId);
  if (!access.signedIn || !access.run) return;
  const { orgId } = access;
  await withOrg(getDb(), orgId, (tx) => cancelRun(tx, orgId, runId));
}
