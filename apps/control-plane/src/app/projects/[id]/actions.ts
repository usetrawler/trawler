"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { withOrg } from "../../../db/tenancy.ts";
import { runModel } from "../../../runs/catalog.ts";
import { DEFAULT_RUN } from "../../../runs/models.ts";
import { startRun } from "../../../runs/runs.ts";
import { getAuth } from "../../../server/auth.ts";
import { getDb, getKeyring } from "../../../server/db.ts";

export interface StartState {
  error?: string;
}

export async function startRunAction(_previous: StartState, form: FormData): Promise<StartState> {
  const projectId = String(form.get("projectId") ?? "");
  const modelId = String(form.get("model") ?? "");
  const budgetUsd = Number(form.get("budget"));
  if (form.get("authorised") !== "on") return { error: "Confirm that you may test this product." };
  if (!(await runModel(getDb(), modelId))) return { error: "Choose a model." };
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0.1 || budgetUsd > 50) return { error: "Set a cap between $0.10 and $50." };
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { error: "Your account has no workspace yet." };
  let runId: string;
  try {
    const run = await withOrg(getDb(), orgId, (tx) =>
      startRun(tx, orgId, projectId, getKeyring(), { budgetUsd, agentModel: modelId, judgeModel: modelId, maxSteps: DEFAULT_RUN.maxSteps, replaySteps: DEFAULT_RUN.replaySteps, createdBy: session.user.id }),
    );
    runId = run.id;
  } catch (err) {
    console.error("run could not start", { message: err instanceof Error ? err.message : String(err) });
    return { error: "The run could not start. Try again." };
  }
  redirect(`/runs/${runId}`);
}
