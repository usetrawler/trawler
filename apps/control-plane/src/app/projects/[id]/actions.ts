"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { keyStillStored, modelKey, modelKeyHint, setModelKey, type KeyHint } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { openRouterPrices, priceFor, type Price } from "../../../llm/prices.ts";
import { projectExists, ProjectNotFound } from "../../../projects/projects.ts";
import { freshEndpoint, withinListingLimit, type KeyInput } from "../../../llm/key-input.ts";
import { checkModelCall, endpointFor, listModels, PREFERRED_MODELS, PROVIDER_LABEL, priceKey, type Endpoint, type Provider } from "../../../llm/providers.ts";
import { DEFAULT_RUN } from "../../../runs/models.ts";
import { startRun } from "../../../runs/runs.ts";
import { canManageBilling, signedInMember } from "../../../server/auth.ts";
import { betaRefusal } from "../../../server/beta.ts";
import { getDb, getKeyring } from "../../../server/db.ts";
import { readEnv } from "../../../server/env.ts";
import { logError, scrubberWith } from "../../../server/log.ts";

export interface StartState {
  error?: string;
  keyHint?: KeyHint;
}

export interface ModelOption {
  id: string;
  price: Price | null;
}

export type ModelList = { ok: true; provider: Provider; models: ModelOption[]; suggested: string } | { ok: false; error: string };

class KeyGone extends Error {}

const MODEL_ID = /^[A-Za-z0-9._:\/@-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function endpointFrom(orgId: string, input: KeyInput): Promise<{ endpoint: Endpoint; fresh: boolean } | { error: string }> {
  const openRouterUrl = readEnv().openRouterUrl;
  const key = (input.key ?? "").trim();
  if (!key) {
    const stored = await withOrg(getDb(), orgId, (tx) => modelKey(tx, orgId, getKeyring()));
    if (!stored) return { error: "Paste an API key from your model provider to start." };
    return { endpoint: endpointFor(stored.provider, stored.key, { openRouterUrl, customUrl: stored.baseUrl }), fresh: false };
  }
  const fresh = freshEndpoint(input, openRouterUrl);
  return "error" in fresh ? fresh : { endpoint: fresh.endpoint, fresh: true };
}


export async function modelsForKeyAction(input: KeyInput): Promise<ModelList> {
  const member = await signedInMember(await headers());
  if (!member) return { ok: false, error: "Sign in again." };
  const { orgId } = member;
  const refusal = betaRefusal(member.email);
  if (refusal) return { ok: false, error: refusal };
  if ((input.key ?? "").trim() && !canManageBilling(member)) return { ok: false, error: "Only an owner or admin of this workspace can change its model key." };
  if (!withinListingLimit(member.userId)) return { ok: false, error: "Too many model lookups. Wait a few minutes, or type a model name." };
  const resolved = await endpointFrom(orgId, input);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { endpoint } = resolved;
  let ids: string[];
  try {
    ids = await listModels(endpoint);
  } catch {
    return { ok: false, error: `${PROVIDER_LABEL[endpoint.provider]} did not list models for this key. Check the key, or type a model name.` };
  }
  const prices = await openRouterPrices(readEnv().openRouterUrl);
  const models = ids.slice(0, 1000).map((id) => {
    const k = priceKey(endpoint.provider, id);
    return { id, price: k ? prices.get(k) ?? null : null };
  });
  const suggested = PREFERRED_MODELS[endpoint.provider].find((id) => ids.includes(id)) ?? ids[0] ?? "";
  return { ok: true, provider: endpoint.provider, models, suggested };
}

export async function startRunAction(_previous: StartState, form: FormData): Promise<StartState> {
  const projectId = String(form.get("projectId") ?? "");
  const modelId = String(form.get("model") ?? "").trim();
  const budgetUsd = Number(form.get("budget"));
  if (form.get("authorised") !== "on") return { error: "Confirm that you may test this product." };
  if (!MODEL_ID.test(modelId)) return { error: "Choose a model or type its exact name." };
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0.1 || budgetUsd > 50) return { error: "Set a cap between $0.10 and $50." };
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const refusal = betaRefusal(member.email);
  if (refusal) return { error: refusal };
  if (!UUID.test(projectId) || !(await withOrg(getDb(), orgId, (tx) => projectExists(tx, orgId, projectId)))) return { error: "The run could not start. Try again." };

  const resolved = await endpointFrom(orgId, { key: String(form.get("apiKey") ?? ""), provider: String(form.get("provider") ?? ""), baseUrl: String(form.get("baseUrl") ?? "") });
  if ("error" in resolved) return { error: resolved.error };
  const { endpoint, fresh } = resolved;
  if (fresh && !canManageBilling(member)) return { error: "Only an owner or admin of this workspace can change its model key." };
  const label = PROVIDER_LABEL[endpoint.provider];
  const check = await checkModelCall(endpoint, modelId);
  if (!check.ok) {
    const detail = check.detail ? ` (${check.detail})` : "";
    if (check.reason === "key") return { error: `${label} did not accept this key${detail}.` };
    if (check.reason === "model") return { error: `This key cannot use ${modelId}${detail}. Pick another model.` };
    return { error: `${label} could not be reached to check the key. Try again in a moment.` };
  }
  if (fresh) {
    await withOrg(getDb(), orgId, (tx) => setModelKey(tx, orgId, { provider: endpoint.provider, key: endpoint.key, baseUrl: endpoint.provider === "custom" ? endpoint.baseUrl : null }, member.userId, getKeyring()));
    revalidatePath(`/projects/${projectId}`);
  }
  const price = await priceFor(endpoint.provider, modelId, readEnv().openRouterUrl);
  let runId: string;
  const providerBaseUrl = endpoint.provider === "custom" ? endpoint.baseUrl : null;
  try {
    const run = await withOrg(getDb(), orgId, async (tx) => {
      if (!(await keyStillStored(tx, orgId, endpoint.provider, providerBaseUrl))) throw new KeyGone();
      return startRun(tx, orgId, projectId, getKeyring(), {
        budgetUsd, agentModel: modelId, judgeModel: modelId, maxSteps: DEFAULT_RUN.maxSteps, replaySteps: DEFAULT_RUN.replaySteps, createdBy: member.userId,
        provider: endpoint.provider, providerBaseUrl, price, tokenCap: price ? null : DEFAULT_RUN.tokenCap,
      });
    });
    runId = run.id;
  } catch (err) {
    const keyHint = await withOrg(getDb(), orgId, (tx) => modelKeyHint(tx, orgId));
    if (err instanceof KeyGone) {
      revalidatePath(`/projects/${projectId}`);
      return { error: "The workspace's model key was removed or changed while the run was starting. Check the key and start again.", ...(keyHint ? { keyHint } : {}) };
    }
    if (!(err instanceof ProjectNotFound)) await logError("run could not start", { orgId, projectId, err }, scrubberWith([endpoint.key]));
    return { error: "The run could not start. Try again.", ...(keyHint ? { keyHint } : {}) };
  }
  redirect(`/runs/${runId}`);
}
