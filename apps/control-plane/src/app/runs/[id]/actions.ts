"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { keyStillStored, modelKey } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { priceFor } from "../../../llm/prices.ts";
import { providerArticle } from "../../../llm/provider-kinds.ts";
import { checkModelCall, endpointFor, PROVIDER_LABEL, type Provider } from "../../../llm/providers.ts";
import { DEFAULT_RUN } from "../../../runs/models.ts";
import { isLive } from "../../../runs/report.ts";
import { cancelRun, CannotJudgeAgain, judgeAgain, RunNotFound, startRun } from "../../../runs/runs.ts";
import { signedInMember } from "../../../server/auth.ts";
import { betaRefusal } from "../../../server/beta.ts";
import { getDb, getKeyring } from "../../../server/db.ts";
import { readEnv } from "../../../server/env.ts";
import { logError, scrubberWith } from "../../../server/log.ts";

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

class KeyGone extends Error {}

const keyName = (provider: Provider) => `${providerArticle(provider)} ${PROVIDER_LABEL[provider]} key`;

export async function runAgainAction(runId: string): Promise<{ error?: string }> {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(runId)) return { error: "This run was not found." };
  const refusal = betaRefusal(member.email);
  if (refusal) return { error: refusal };

  const keys = getKeyring();
  const found = await withOrg(getDb(), orgId, async (tx) => ({
    previous: await tx
      .selectFrom("runs")
      .select(["project_id", "status", "agent_model", "judge_model", "budget_usd", "max_steps", "replay_steps", "provider", "provider_base_url"])
      .where("id", "=", runId)
      .where("org_id", "=", orgId)
      .executeTakeFirst(),
    stored: await modelKey(tx, orgId, keys),
  }));
  const { previous, stored } = found;
  if (!previous) return { error: "This run was not found." };
  if (isLive(previous.status)) return { error: "This run is still going. Run it again once it has finished." };
  if (!stored) return { error: "The workspace has no model key any more. An owner or admin can add one in Settings." };
  const provider = previous.provider as Provider;
  if (stored.provider !== provider) return { error: `This run was paid with ${keyName(provider)}, and the workspace key is now ${keyName(stored.provider)}. Start a run from the plan to choose a model for it.` };
  if (provider === "custom" && stored.baseUrl !== previous.provider_base_url) return { error: "The workspace key now points to another OpenAI-compatible address. Start a run from the plan to choose a model for it." };

  const endpoint = endpointFor(stored.provider, stored.key, { openRouterUrl: readEnv().openRouterUrl, customUrl: stored.baseUrl });
  const label = PROVIDER_LABEL[endpoint.provider];
  for (const model of new Set([previous.agent_model, previous.judge_model])) {
    const check = await checkModelCall(endpoint, model);
    if (check.ok) continue;
    const detail = check.detail ? ` (${check.detail})` : "";
    if (check.reason === "key") return { error: `${label} did not accept the workspace key${detail}. An owner or admin can replace it in Settings.` };
    if (check.reason === "model") return { error: `The workspace key cannot use ${model}${detail}. Start a run from the plan to pick another model.` };
    return { error: `${label} could not be reached to check the key. Try again in a moment.` };
  }

  const price = await priceFor(endpoint.provider, previous.agent_model, readEnv().openRouterUrl);
  const providerBaseUrl = endpoint.provider === "custom" ? endpoint.baseUrl : null;
  let started: string;
  try {
    const run = await withOrg(getDb(), orgId, async (tx) => {
      if (!(await keyStillStored(tx, orgId, endpoint.provider, providerBaseUrl))) throw new KeyGone();
      return startRun(tx, orgId, previous.project_id, keys, {
        budgetUsd: Number(previous.budget_usd), agentModel: previous.agent_model, judgeModel: previous.judge_model,
        maxSteps: previous.max_steps, replaySteps: previous.replay_steps, createdBy: member.userId,
        provider: endpoint.provider, providerBaseUrl, price, tokenCap: price ? null : DEFAULT_RUN.tokenCap,
      });
    });
    started = run.id;
  } catch (err) {
    if (err instanceof KeyGone) return { error: "The workspace's model key was removed or changed while the run was starting. Check the key and run it again." };
    await logError("run could not start again", { orgId, runId, err }, scrubberWith([endpoint.key]));
    return { error: "The run could not start. Try again." };
  }
  redirect(`/runs/${started}`);
}
