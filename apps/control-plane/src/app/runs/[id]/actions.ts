"use server";
import { headers } from "next/headers";
import { withOrg } from "../../../db/tenancy.ts";
import { cancelRun, CannotJudgeAgain, judgeAgain } from "../../../runs/runs.ts";
import { getAuth } from "../../../server/auth.ts";
import { betaRefusal } from "../../../server/beta.ts";
import { getDb, getKeyring } from "../../../server/db.ts";
import { logError } from "../../../server/log.ts";

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

export async function judgeAgainAction(runId: string, findingKey: string): Promise<{ error?: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const orgId = session?.session.activeOrganizationId;
  if (!session || !orgId) return { error: "Sign in again." };
  if (!UUID.test(runId) || typeof findingKey !== "string" || findingKey.length < 1 || findingKey.length > 200) return { error: "This finding cannot be judged again." };
  const refusal = betaRefusal(session.user.email);
  if (refusal) return { error: refusal };
  try {
    await withOrg(getDb(), orgId, (tx) => judgeAgain(tx, orgId, runId, findingKey, session.user.id, getKeyring()));
    return {};
  } catch (err) {
    if (err instanceof CannotJudgeAgain) return { error: err.message };
    await logError("judge again could not start", { orgId, runId, err });
    return { error: "The judge could not be started. Try again." };
  }
}
