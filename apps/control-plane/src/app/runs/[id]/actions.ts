"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { keyStillStored, modelKey } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { priceFor, type Price } from "../../../llm/prices.ts";
import { providerArticle } from "../../../llm/provider-kinds.ts";
import { runCheckRefusal } from "../../../llm/key-input.ts";
import { checkModelCall, endpointFor, PROVIDER_LABEL, type Provider } from "../../../llm/providers.ts";
import { CannotDismiss, dismissFinding, undoDismissal } from "../../../runs/dismissals.ts";
import { DEFAULT_RUN } from "../../../runs/models.ts";
import { isLive } from "../../../runs/report.ts";
import { cancelRun, CannotJudgeAgain, firstRunOnUsLeft, judgeAgain, NeedsAccount, personWithoutAccount, refusalToStart, RunInProgress, RunNotFound, RunRefused, startRun } from "../../../runs/runs.ts";
import { signedInMember } from "../../../server/auth.ts";
import { runPath } from "../../../runs/status.ts";
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
    await withOrg(getDb(), orgId, (tx) => cancelRun(tx, orgId, runId, "stopped"));
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

const isFindingKey = (key: unknown): key is string => typeof key === "string" && key.length >= 1 && key.length <= 200;

export async function dismissFindingAction(runId: string, findingKey: string, reason: string): Promise<{ error?: string }> {
  const member = await signedInMember(await headers());
  if (!member) return { error: "Sign in again." };
  const { orgId } = member;
  if (!UUID.test(runId) || !isFindingKey(findingKey)) return { error: "This finding was not found." };
  try {
    await withOrg(getDb(), orgId, (tx) => dismissFinding(tx, orgId, runId, findingKey, reason, member.userId));
    return {};
  } catch (err) {
    if (err instanceof CannotDismiss) return { error: err.message };
    await logError("finding could not be marked not a bug", { orgId, runId, err });
    return { error: "It could not be marked not a bug. Try again." };
  }
}

export async function undoDismissalAction(runId: string, findingKey: string): Promise<{ error?: string }> {
  const member = await signedInMember(await headers());
  if (!member) return { error: "Sign in again." };
  const { orgId } = member;
  if (!UUID.test(runId) || !isFindingKey(findingKey)) return { error: "This finding was not found." };
  try {
    await withOrg(getDb(), orgId, (tx) => undoDismissal(tx, orgId, runId, findingKey));
    return {};
  } catch (err) {
    if (err instanceof CannotDismiss) return { error: err.message };
    await logError("not a bug could not be undone", { orgId, runId, err });
    return { error: "It could not be undone. Try again." };
  }
}

class KeyGone extends Error {}

export interface RunAgainState {
  error?: string;
  activeRun?: { id: string; number: number };
}

const refusedState = (refused: RunRefused): RunAgainState => ({ error: refused.message, ...(refused instanceof RunInProgress ? { activeRun: refused.run } : {}) });

const pricedBefore = (run: { prompt_usd_per_mtok: string | null; completion_usd_per_mtok: string | null }): Price | null =>
  run.prompt_usd_per_mtok !== null && run.completion_usd_per_mtok !== null ? { promptUsdPerMtok: Number(run.prompt_usd_per_mtok), completionUsdPerMtok: Number(run.completion_usd_per_mtok) } : null;

const keyName = (provider: Provider) => `${providerArticle(provider)} ${PROVIDER_LABEL[provider]} key`;

export async function runAgainAction(_previous: RunAgainState, form: FormData): Promise<RunAgainState> {
  const runId = String(form.get("runId") ?? "");
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
      .select(["project_id", "status", "agent_model", "judge_model", "budget_usd", "provider", "provider_base_url", "prompt_usd_per_mtok", "completion_usd_per_mtok", "paid_by"])
      .where("id", "=", runId)
      .where("org_id", "=", orgId)
      .executeTakeFirst(),
    stored: await modelKey(tx, orgId, keys),
  }));
  const { previous, stored } = found;
  const without = previous && (await withOrg(getDb(), orgId, (tx) => personWithoutAccount(tx, previous.project_id)));
  if (without) return { error: `${new NeedsAccount(without).message} Choose one on the plan, then run it again.` };
  if (!previous) return { error: "This run was not found." };
  if (isLive(previous.status)) return { error: "This run is still going. Run it again once it has finished." };
  const refused = await withOrg(getDb(), orgId, (tx) => refusalToStart(tx, orgId, previous.project_id));
  if (refused) return refusedState(refused);
  const onUs = previous.paid_by === "trawler";
  if (onUs && (await withOrg(getDb(), orgId, (tx) => firstRunOnUsLeft(tx, orgId)))) return { error: "This run ended before Trawler paid for any model call, so the first run on Trawler is still yours. Start it from the plan." };
  if (!stored) return { error: onUs ? "Trawler paid for this workspace's first run. To run it again, start a run from the plan and add a model key there." : "The workspace has no model key any more. An owner or admin can add one in Settings." };
  const provider = previous.provider as Provider;
  if (stored.provider !== provider) return { error: `This run was paid ${onUs ? "by Trawler on OpenRouter" : `with ${keyName(provider)}`}, and the workspace key is now ${keyName(stored.provider)}. Start a run from the plan to choose a model for it.` };
  if (provider === "custom" && stored.baseUrl !== previous.provider_base_url) return { error: "The workspace key now points to another OpenAI-compatible address. Start a run from the plan to choose a model for it." };

  const tooOften = runCheckRefusal(member);
  if (tooOften) return { error: tooOften };
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

  const price = (await priceFor(endpoint.provider, previous.agent_model, readEnv().openRouterUrl)) ?? pricedBefore(previous);
  const providerBaseUrl = endpoint.provider === "custom" ? endpoint.baseUrl : null;
  let started: number;
  try {
    const run = await withOrg(getDb(), orgId, async (tx) => {
      if (!(await keyStillStored(tx, orgId, endpoint.provider, providerBaseUrl))) throw new KeyGone();
      return startRun(tx, orgId, previous.project_id, keys, {
        budgetUsd: Number(previous.budget_usd), agentModel: previous.agent_model, judgeModel: previous.judge_model,
        maxSteps: DEFAULT_RUN.maxSteps, replaySteps: DEFAULT_RUN.replaySteps, createdBy: member.userId,
        provider: endpoint.provider, providerBaseUrl, price, tokenCap: price ? null : DEFAULT_RUN.tokenCap,
      });
    });
    started = run.number;
  } catch (err) {
    if (err instanceof KeyGone) return { error: "The workspace's model key was removed or changed while the run was starting. Check the key and run it again." };
    if (err instanceof NeedsAccount) return { error: `${err.message} Choose one on the plan, then run it again.` };
    if (err instanceof RunRefused) return refusedState(err);
    await logError("run could not start again", { orgId, runId, err }, scrubberWith([endpoint.key]));
    return { error: "The run could not start. Try again." };
  }
  redirect(runPath(started));
}
