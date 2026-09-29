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
  stopped?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function onProject(projectId: string, change: (orgId: string, userId: string) => Promise<number | void>, failure: string): Promise<PauseState> {
  const member = await signedInMember(await headers());
  if (!member) return { error: "Sign in again." };
  if (!UUID.test(projectId)) return { error: "This project was not found." };
  try {
    const stopped = await change(member.orgId, member.userId);
    revalidatePath("/", "layout");
    return typeof stopped === "number" ? { stopped } : {};
  } catch (err) {
    if (err instanceof ProjectNotFound) return { error: "This project was not found." };
    await logError(failure, { orgId: member.orgId, projectId, err });
    return { error: "That did not work. Try again." };
  }
}

export async function pauseRunsAction(projectId: string): Promise<PauseState> {
  return onProject(projectId, (orgId, userId) => withOrg(getDb(), orgId, (tx) => pauseProject(tx, orgId, projectId, userId)), "runs could not be paused");
}

export async function resumeRunsAction(projectId: string): Promise<PauseState> {
  return onProject(projectId, (orgId) => withOrg(getDb(), orgId, (tx) => resumeProject(tx, orgId, projectId)), "runs could not be resumed");
}
