"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkOpenRouterKey, openRouterKeyHint, setOpenRouterKey } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { readEnv } from "../../../server/env.ts";
import { runModel } from "../../../runs/catalog.ts";
import { DEFAULT_RUN } from "../../../runs/models.ts";
import { startRun } from "../../../runs/runs.ts";
import { canManageBilling, getAuth } from "../../../server/auth.ts";
import { getDb, getKeyring } from "../../../server/db.ts";

export interface StartState {
  error?: string;
  keyHint?: string;
}

export async function startRunAction(_previous: StartState, form: FormData): Promise<StartState> {
  const projectId = String(form.get("projectId") ?? "");
  const modelId = String(form.get("model") ?? "");
  const budgetUsd = Number(form.get("budget"));
  if (form.get("authorised") !== "on") return { error: "Confirm that you may test this product." };
  if (!(await runModel(getDb(), modelId))) return { error: "Choose a model." };
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0.1 || budgetUsd > 50) return { error: "Set a cap between $0.10 and $50." };
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { error: "Your account has no workspace yet." };
  const newKey = String(form.get("openrouterKey") ?? "").trim();
  if (newKey) {
    if (!(await canManageBilling(requestHeaders))) return { error: "Only an owner of this workspace can change its OpenRouter key." };
    const check = await checkOpenRouterKey(newKey, { baseUrl: readEnv().openRouterUrl });
    if (check === "invalid") return { error: "OpenRouter did not accept that key. Copy it again from openrouter.ai/settings/keys." };
    if (check === "unavailable") return { error: "OpenRouter could not be reached to check the key. Try again in a moment." };
    await withOrg(getDb(), orgId, (tx) => setOpenRouterKey(tx, orgId, newKey, session.user.id, getKeyring()));
    revalidatePath(`/projects/${projectId}`);
  } else if (!(await withOrg(getDb(), orgId, (tx) => openRouterKeyHint(tx, orgId)))) {
    return { error: "Add your OpenRouter key to start." };
  }
  let runId: string;
  try {
    const run = await withOrg(getDb(), orgId, (tx) =>
      startRun(tx, orgId, projectId, getKeyring(), { budgetUsd, agentModel: modelId, judgeModel: modelId, maxSteps: DEFAULT_RUN.maxSteps, replaySteps: DEFAULT_RUN.replaySteps, createdBy: session.user.id }),
    );
    runId = run.id;
  } catch (err) {
    console.error("run could not start", { message: err instanceof Error ? err.message : String(err) });
    const keyHint = await withOrg(getDb(), orgId, (tx) => openRouterKeyHint(tx, orgId));
    return { error: "The run could not start. Try again.", ...(keyHint ? { keyHint } : {}) };
  }
  redirect(`/runs/${runId}`);
}
