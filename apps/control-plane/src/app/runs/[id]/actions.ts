"use server";
import { headers } from "next/headers";
import { withOrg } from "../../../db/tenancy.ts";
import { cancelRun, CannotJudgeAgain, judgeAgain, RunNotFound } from "../../../runs/runs.ts";
import { signedInMember } from "../../../server/auth.ts";
import { betaRefusal } from "../../../server/beta.ts";
import { getDb, getKeyring } from "../../../server/db.ts";
import { logError } from "../../../server/log.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function cancelRunAction(runId: string): Promise<boolean> {
  const member = await signedInMember(await headers());
  if (!member || !UUID.test(runId)) return false;
  const { orgId } = member;
  try {
    await withOrg(getDb(), orgId, (tx) => cancelRun(tx, orgId, runId));
    return true;
  } catch (err) {
    if (!(err instanceof RunNotFound)) await logError("run could not be cancelled", { orgId, runId, err });
    return false;
  }
}

export async function judgeAgainAction(runId: string, findingKey: string): Promise<{ error?: string }> {
  const member = await signedInMember(await headers());
  if (!member) return { error: "Sign in again." };
  const { orgId } = member;
  if (!UUID.test(runId) || typeof findingKey !== "string" || findingKey.length < 1 || findingKey.length > 200) return { error: "This finding cannot be judged again." };
  const refusal = betaRefusal(member.email);
  if (refusal) return { error: refusal };
  try {
    await withOrg(getDb(), orgId, (tx) => judgeAgain(tx, orgId, runId, findingKey, member.userId, getKeyring()));
    return {};
  } catch (err) {
    if (err instanceof CannotJudgeAgain) return { error: err.message };
    await logError("judge again could not start", { orgId, runId, err });
    return { error: "The judge could not be started. Try again." };
  }
}
