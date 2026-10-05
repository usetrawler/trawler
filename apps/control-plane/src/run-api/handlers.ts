import { StartRunRequestSchema } from "@usetrawler/protocol";
import { keyStillStored, modelKey } from "../credentials/credentials.ts";
import type { Database } from "../db/index.ts";
import { withOrg } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { modelCheckRefusal } from "../llm/model-check.ts";
import { priceFor, type Price } from "../llm/prices.ts";
import { checkModelCall, endpointFor, PREFERRED_MODELS, type Endpoint, type Provider } from "../llm/providers.ts";
import { projectRunCount } from "../projects/overview.ts";
import { planOf, PlanNotFound, projectExists, ProjectNotFound } from "../projects/projects.ts";
import { runResultOf } from "../runs/comment.ts";
import { DEFAULT_RUN, FIRST_RUN_ON_US } from "../runs/models.ts";
import { workspacePlan } from "../runs/plans.ts";
import { cancelRun, firstRunOnUsLeft, NeedsAccount, personWithoutAccount, refusalToStart, RunInProgress, RunRefused, runSummary, startRun, type PaidBy } from "../runs/runs.ts";
import { runPath } from "../runs/status.ts";
import { tokenWorkspace } from "../server/api-token.ts";

export interface RunApiDeps {
  db: Database;
  keys: Keyring;
  baseUrl: string;
  openRouterUrl: string;
  trawlerPays: boolean;
  priceOf?: (provider: Provider, model: string, openRouterUrl: string) => Promise<Price | null>;
  modelCheck?: typeof checkModelCall;
  afterStart?: () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_ID = /^[A-Za-z0-9._:\/@-]{1,200}$/;
const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
const ok = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

class KeyGone extends Error {}
class FirstRunFromApp extends Error {}

const CHECK_STATUS = { key: 422, model: 422, unavailable: 503 } as const;

interface Payer {
  paidBy: PaidBy;
  provider: Provider;
  providerBaseUrl: string | null;
  model: string;
  budgetUsd: number;
  usesFirstRunOnUs: boolean;
}

const trawlerPayer = (cap: number | undefined, usesFirstRunOnUs: boolean): Payer => ({
  paidBy: "trawler", provider: "openrouter", providerBaseUrl: null, model: FIRST_RUN_ON_US.model, budgetUsd: Math.min(cap ?? FIRST_RUN_ON_US.budgetUsd, FIRST_RUN_ON_US.budgetUsd), usesFirstRunOnUs,
});

export async function handleStartRun(req: Request, deps: RunApiDeps): Promise<Response> {
  const auth = await tokenWorkspace(req.headers, deps.db);
  if (!auth.ok) return auth.response;
  const { holder } = auth;
  const raw = await req.json().catch(() => undefined);
  const parsed = StartRunRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(400, `Invalid request: ${issue ? `${issue.path.join(".") || "body"} ${issue.message}` : "unreadable body"}.`);
  }
  const body = parsed.data;
  if (holder.projectId && holder.projectId !== body.project) return fail(403, "This API token is limited to another project.");
  if (body.model !== undefined && !MODEL_ID.test(body.model)) return fail(400, "Invalid request: model is not a valid model name.");
  if (body.url !== undefined && body.execution !== "own") return fail(422, "A different target URL can only be tested by a runner in your own network. Use execution \"own\", or leave the URL out to test the project's target.");
  if (body.accounts?.length && body.execution !== "own") return fail(400, "Invalid request: accounts can only be given with execution \"own\", because a hosted runner cannot read the CI job's accounts.");
  const { orgId } = holder;
  const priceOf = deps.priceOf ?? priceFor;
  try {
    const { plan, payer, endpoint } = await withOrg(deps.db, orgId, async (tx) => {
      if (!(await projectExists(tx, orgId, body.project))) throw new ProjectNotFound();
      if ((await projectRunCount(tx, orgId, body.project)) === 0) throw new FirstRunFromApp();
      const plan = await planOf(tx, orgId, body.project, body.plan);
      const without = await personWithoutAccount(tx, plan.id, body.accounts);
      if (without) throw new NeedsAccount(without);
      const stored = await modelKey(tx, orgId, deps.keys);
      let payer: Payer;
      let endpoint: Endpoint | null = null;
      if (stored) {
        const model = body.model ?? PREFERRED_MODELS[stored.provider][0];
        if (!model) throw new RunRefused("This workspace uses its own endpoint, so say which model to use.");
        payer = { paidBy: "workspace", provider: stored.provider, providerBaseUrl: stored.provider === "custom" ? stored.baseUrl : null, model, budgetUsd: body.cap ?? DEFAULT_RUN.budgetUsd, usesFirstRunOnUs: false };
        endpoint = endpointFor(stored.provider, stored.key, { openRouterUrl: deps.openRouterUrl, customUrl: stored.baseUrl });
      } else if ((await workspacePlan(tx, orgId)).plan === "enterprise" && deps.trawlerPays) {
        payer = trawlerPayer(body.cap, false);
      } else if (deps.trawlerPays && (await firstRunOnUsLeft(tx, orgId))) {
        payer = trawlerPayer(body.cap, true);
      } else {
        throw new RunRefused("Add a model key in Settings to start runs.");
      }
      const refused = await refusalToStart(tx, orgId, body.project, payer.paidBy, plan.id);
      if (refused) throw refused;
      return { plan, payer, endpoint };
    });
    if (endpoint) {
      const checkRefusal = await modelCheckRefusal(endpoint, payer.model, deps.modelCheck);
      if (checkRefusal) return fail(CHECK_STATUS[checkRefusal.reason], checkRefusal.error);
    }
    const run = await withOrg(deps.db, orgId, async (tx) => {
      if (payer.paidBy === "workspace" && !(await keyStillStored(tx, orgId, payer.provider, payer.providerBaseUrl))) throw new KeyGone();
      const price = await priceOf(payer.provider, payer.model, deps.openRouterUrl);
      return startRun(tx, orgId, body.project, deps.keys, {
        budgetUsd: payer.budgetUsd, agentModel: payer.model, judgeModel: payer.model, maxSteps: DEFAULT_RUN.maxSteps, replaySteps: DEFAULT_RUN.replaySteps, createdBy: `api-token:${holder.tokenId}`,
        provider: payer.provider, providerBaseUrl: payer.providerBaseUrl, price, tokenCap: price ? null : DEFAULT_RUN.tokenCap, paidBy: payer.paidBy,
        planId: plan.id, execution: body.execution, targetUrl: body.url, pullRequest: body.pullRequest, planMode: body.planMode, replan: body.replan, conversation: body.conversation, providedAccounts: body.accounts, usesFirstRunOnUs: payer.usesFirstRunOnUs,
      });
    });
    if (body.pullRequest) deps.afterStart?.();
    return ok({ id: run.id, number: run.number, reportUrl: `${deps.baseUrl.replace(/\/+$/, "")}${runPath(run.number)}`, people: run.people }, 201);
  } catch (err) {
    if (err instanceof ProjectNotFound) return fail(404, "That project is not in this workspace.");
    if (err instanceof FirstRunFromApp) return fail(412, "Start the first run of this project from the app, where you confirm you are authorised to test it. Runs started with an API token are available after that.");
    if (err instanceof PlanNotFound) return fail(404, "That plan is not on this project.");
    if (err instanceof NeedsAccount) return fail(422, err.message);
    if (err instanceof RunInProgress) return fail(409, err.message);
    if (err instanceof RunRefused) return fail(422, err.message);
    if (err instanceof KeyGone) return fail(409, "The workspace's model key was removed or changed while the run was starting. Try again.");
    throw err;
  }
}

export async function handleGetRun(req: Request, id: string, deps: RunApiDeps): Promise<Response> {
  const auth = await tokenWorkspace(req.headers, deps.db);
  if (!auth.ok) return auth.response;
  const { holder } = auth;
  if (!UUID.test(id)) return fail(404, "Run not found.");
  const summary = await withOrg(deps.db, holder.orgId, (tx) => runSummary(tx, holder.orgId, id));
  if (!summary || (holder.projectId && summary.projectId !== holder.projectId)) return fail(404, "Run not found.");
  return ok(runResultOf(summary, deps.baseUrl));
}

export async function handleStopRun(req: Request, id: string, deps: RunApiDeps): Promise<Response> {
  const auth = await tokenWorkspace(req.headers, deps.db);
  if (!auth.ok) return auth.response;
  const { holder } = auth;
  if (!UUID.test(id)) return fail(404, "Run not found.");
  const outcome = await withOrg(deps.db, holder.orgId, async (tx) => {
    const run = await tx.selectFrom("runs").select("project_id").where("id", "=", id).where("org_id", "=", holder.orgId).executeTakeFirst();
    if (!run || (holder.projectId && run.project_id !== holder.projectId)) return null;
    const stopped = await cancelRun(tx, holder.orgId, id, "stopped_from_ci");
    const { status } = await tx.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirstOrThrow();
    return { id, status, stopped };
  });
  return outcome ? ok(outcome) : fail(404, "Run not found.");
}
