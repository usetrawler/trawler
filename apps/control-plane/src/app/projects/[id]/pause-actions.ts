"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { withOrg } from "../../../db/tenancy.ts";
import { ProjectNotFound } from "../../../projects/projects.ts";
import { pauseProject, resumeProject } from "../../../runs/runs.ts";
import { signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { logError } from "../../../server/log.ts";

export interface PauseState {
  error?: string;
  stopped?: { id: string; number: number } | null;
  alsoStopped?: number;
  liveRun?: { id: string; number: number; more?: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function onProject(projectId: string, change: (orgId: string, userId: string) => Promise<PauseState>, failure: string, refused: string): Promise<PauseState> {
  const member = await signedInMember(await headers());
  if (!member) return { error: "Sign in again." };
  if (!UUID.test(projectId)) return { error: "This project was not found." };
  try {
    const outcome = await change(member.orgId, member.userId);
    if (!outcome.liveRun) revalidatePath("/", "layout");
    return outcome;
  } catch (err) {
    if (err instanceof ProjectNotFound) return { error: "This project was not found." };
    await logError(failure, { orgId: member.orgId, projectId, err });
    return { error: refused };
  }
}

export async function pauseRunsAction(projectId: string, confirmedRunId: string | null): Promise<PauseState> {
  const confirmed = typeof confirmedRunId === "string" && UUID.test(confirmedRunId) ? confirmedRunId : null;
  return onProject(
    projectId,
    async (orgId, userId) => {
      const outcome = await withOrg(getDb(), orgId, (tx) => pauseProject(tx, orgId, projectId, userId, confirmed));
      return "unconfirmed" in outcome ? { liveRun: outcome.unconfirmed } : { stopped: outcome.stopped, ...(outcome.alsoStopped ? { alsoStopped: outcome.alsoStopped } : {}) };
    },
    "runs could not be paused",
    "Runs could not be paused. Try again.",
  );
}

export async function resumeRunsAction(projectId: string): Promise<PauseState> {
  return onProject(projectId, async (orgId) => {
    await withOrg(getDb(), orgId, (tx) => resumeProject(tx, orgId, projectId));
    return {};
  }, "runs could not be resumed", "Runs could not be resumed. Try again.");
}
