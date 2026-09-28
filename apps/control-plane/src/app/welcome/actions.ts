"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { WorkspaceChoice } from "../../auth/onboarding.ts";
import { getAuth, signedInPerson, type Newcomer } from "../../server/auth.ts";
import { NO_LONGER_OPEN, type ChoiceState } from "./choice-state.ts";

async function newcomer(): Promise<Newcomer> {
  const person = await signedInPerson(await headers());
  if (!person) redirect("/sign-in");
  if ("member" in person) redirect("/");
  return person.newcomer;
}

async function choose(choice: WorkspaceChoice): Promise<ChoiceState> {
  const who = await newcomer();
  const chosen = await getAuth().chooseWorkspace({ id: who.sessionId, userId: who.userId }, choice);
  revalidatePath("/", "layout");
  if (!chosen) return { error: NO_LONGER_OPEN };
  redirect("/");
}

export async function joinWorkspaceAction(_previous: ChoiceState, form: FormData): Promise<ChoiceState> {
  const invitationId = String(form.get("invitationId") ?? "");
  if (!invitationId) return { error: NO_LONGER_OPEN };
  return choose({ join: invitationId });
}

export async function startOwnWorkspaceAction(): Promise<ChoiceState> {
  return choose("own");
}
