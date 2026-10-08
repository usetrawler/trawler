import { sql } from "kysely";
import { IDEMPOTENCY_KEY, StartRunRequestSchema } from "@usetrawler/protocol";
import type { z } from "zod";
import { keyStillStored, modelKey } from "../credentials/credentials.ts";
import type { Database } from "../db/index.ts";
import { withOrg } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { modelCheckRefusal } from "../llm/model-check.ts";
import { priceFor, type Price } from "../llm/prices.ts";
import { checkModelCall, endpointFor, PREFERRED_MODELS, type Endpoint, type Provider } from "../llm/providers.ts";
import { projectAuthorised } from "../projects/overview.ts";
import { planOf, PlanNotFound, projectExists, ProjectNotFound } from "../projects/projects.ts";
import { runResultOf } from "../runs/comment.ts";
import { DEFAULT_RUN, FIRST_RUN_ON_US } from "../runs/models.ts";
import { workspacePlan } from "../runs/plans.ts";
import { cancelRun, FirstRunOnUsUsed, firstRunOnUsLeft, NeedsAccount, personWithoutAccount, refusalToStart, RunInProgress, RunRefused, runSummary, startRun, TooManyOwnRuns, type PaidBy } from "../runs/runs.ts";
import { runPath } from "../runs/status.ts";
import type { RunVia } from "../runs/via.ts";
import { claimStart, keyHashOf, recordStart, requestHashOf, storedStart, type StoredStart } from "./idempotency.ts";

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

export interface RunPrincipal {
  subject: "API token" | "connection";
  orgId: string;
  projectId: string | null;
  actor: string;
  via?: RunVia;
  can: { read: boolean; control: boolean };
}

export type Outcome<T> = { ok: true; status: number; value: T; replayed?: true } | { ok: false; status: number; error: string; code?: "model_key" };

export interface StartedRun {
  id: string;
  number: number;
  reportUrl: string;
  people: Awaited<ReturnType<typeof startRun>>["people"];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_ID = /^[A-Za-z0-9._:\/@-]{1,200}$/;
const refuse = (status: number, error: string, code?: "model_key"): Outcome<never> => ({ ok: false, status, error, ...(code ? { code } : {}) });
const succeed = <T>(value: T, status = 200): Outcome<T> => ({ ok: true, status, value });
const notAllowed = (principal: RunPrincipal) => `This ${principal.subject} is not allowed to do that.`;

class KeyGone extends Error {}
class Replayed extends Error {
  constructor(readonly stored: StoredStart) {
    super("replayed");
  }
}
class FirstRunFromApp extends Error {}
class NoModelKey extends RunRefused {
  constructor() {
    super("Add a model key in Settings to start runs.");
  }
}

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

export type ParsedStartRun = z.output<typeof StartRunRequestSchema>;

const DIFFERENT_REQUEST = "This Idempotency-Key was already used for a different request. Use a new key for a new run.";

function replayOf(stored: StoredStart, requestHash: string): Outcome<StartedRun> {
  if (stored.requestHash !== requestHash) return refuse(409, DIFFERENT_REQUEST);
  return { ok: true, status: 201, value: stored.response as StartedRun, replayed: true };
}

export async function startRunFor(principal: RunPrincipal, body: ParsedStartRun, deps: RunApiDeps, options: { idempotencyKey?: string } = {}): Promise<Outcome<StartedRun>> {
  if (!principal.can.control) return refuse(403, notAllowed(principal));
  if (principal.projectId && principal.projectId !== body.project) return refuse(403, `This ${principal.subject} is limited to another project.`);
  if (body.model !== undefined && !MODEL_ID.test(body.model)) return refuse(400, "Invalid request: model is not a valid model name.");
  if (body.url !== undefined && body.execution !== "own") return refuse(422, "A different target URL can only be tested by a runner in your own network. Use execution \"own\", or leave the URL out to test the project's target.");
  if (body.allowedOrigins?.length && (body.execution !== "own" || body.url === undefined)) return refuse(400, "Invalid request: other addresses can only be allowed with execution \"own\" and a target URL, because they are next to an app in your own network.");
  if (body.accounts?.length && body.execution !== "own") return refuse(400, "Invalid request: accounts can only be given with execution \"own\", because a hosted runner cannot read the CI job's accounts.");
  const { orgId } = principal;
  if (options.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(options.idempotencyKey)) return refuse(400, "Invalid request: Idempotency-Key must be 1 to 255 characters: letters, digits and . _ : -");
  const keyHash = options.idempotencyKey ? keyHashOf(options.idempotencyKey) : null;
  const requestHash = keyHash ? requestHashOf(StartRunRequestSchema.parse(body)) : null;
  if (keyHash && requestHash) {
    const stored = await withOrg(deps.db, orgId, (tx) => storedStart(tx, orgId, keyHash));
    if (stored) return replayOf(stored, requestHash);
  }
  const priceOf = deps.priceOf ?? priceFor;
  try {
    const { plan, payer, endpoint } = await withOrg(deps.db, orgId, async (tx) => {
      if (!(await projectExists(tx, orgId, body.project))) throw new ProjectNotFound();
      if (!(await projectAuthorised(tx, orgId, body.project))) throw new FirstRunFromApp();
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
        throw new NoModelKey();
      }
      const refused = await refusalToStart(tx, orgId, body.project, payer.paidBy, plan.id, { execution: body.execution, targetUrl: body.url, pullRequest: body.pullRequest });
      if (refused) throw refused;
      return { plan, payer, endpoint };
    });
    if (endpoint) {
      const checkRefusal = await modelCheckRefusal(endpoint, payer.model, deps.modelCheck);
      if (checkRefusal) return refuse(CHECK_STATUS[checkRefusal.reason], checkRefusal.error, "model_key");
    }
    const run = await withOrg(deps.db, orgId, async (tx) => {
      if (keyHash && requestHash) {
        const taken = await claimStart(tx, orgId, keyHash, requestHash, body.project);
        if (taken) throw new Replayed(taken);
      }
      if (payer.paidBy === "workspace" && !(await keyStillStored(tx, orgId, payer.provider, payer.providerBaseUrl))) throw new KeyGone();
      const price = await priceOf(payer.provider, payer.model, deps.openRouterUrl);
      const started = await startRun(tx, orgId, body.project, deps.keys, {
        budgetUsd: payer.budgetUsd, agentModel: payer.model, judgeModel: payer.model, maxSteps: DEFAULT_RUN.maxSteps, replaySteps: DEFAULT_RUN.replaySteps, createdBy: principal.actor, ...(principal.via ? { startedVia: principal.via } : {}),
        provider: payer.provider, providerBaseUrl: payer.providerBaseUrl, price, tokenCap: price ? null : DEFAULT_RUN.tokenCap, paidBy: payer.paidBy,
        planId: plan.id, execution: body.execution, targetUrl: body.url, extraOrigins: body.allowedOrigins, pullRequest: body.pullRequest, planMode: body.planMode, replan: body.replan, conversation: body.conversation, providedAccounts: body.accounts, usesFirstRunOnUs: payer.usesFirstRunOnUs,
      });
      await tx.updateTable("runs").set({ client_seen_at: sql<Date>`now()` }).where("id", "=", started.id).execute();
      const response: StartedRun = { id: started.id, number: started.number, reportUrl: `${deps.baseUrl.replace(/\/+$/, "")}${runPath(started.number)}`, people: started.people };
      if (keyHash) await recordStart(tx, orgId, keyHash, started.id, response);
      return { started, response };
    });
    if (body.pullRequest) deps.afterStart?.();
    return succeed(run.response, 201);
  } catch (err) {
    if (err instanceof Replayed && requestHash) return replayOf(err.stored, requestHash);
    const refusal = refusalOf(err, principal);
    if (!refusal) throw err;
    if (keyHash && requestHash) {
      const stored = await withOrg(deps.db, orgId, (tx) => storedStart(tx, orgId, keyHash));
      if (stored) return replayOf(stored, requestHash);
    }
    return refusal;
  }
}

function refusalOf(err: unknown, principal: RunPrincipal): Outcome<never> | null {
  if (err instanceof ProjectNotFound) return refuse(404, "That project is not in this workspace.");
  if (err instanceof FirstRunFromApp) return refuse(412, `Start the first run of this project from the app, where you confirm you are authorised to test it. Runs started ${principal.subject === "API token" ? "with an API token" : "by an assistant"} are available after that.`);
  if (err instanceof PlanNotFound) return refuse(404, "That plan is not on this project.");
  if (err instanceof NeedsAccount) return refuse(422, err.message);
  if (err instanceof RunInProgress) return refuse(409, err.message);
  if (err instanceof TooManyOwnRuns) return refuse(429, err.message);
  if (err instanceof NoModelKey || err instanceof FirstRunOnUsUsed) return refuse(422, err.message, "model_key");
  if (err instanceof RunRefused) return refuse(422, err.message);
  if (err instanceof KeyGone) return refuse(409, "The workspace's model key was removed or changed while the run was starting. Try again.");
  return null;
}

export async function readRunFor(principal: RunPrincipal, id: string, deps: RunApiDeps): Promise<Outcome<ReturnType<typeof runResultOf>>> {
  if (!principal.can.read) return refuse(403, notAllowed(principal));
  if (!UUID.test(id)) return refuse(404, "Run not found.");
  const summary = await withOrg(deps.db, principal.orgId, async (tx) => {
    const found = await runSummary(tx, principal.orgId, id);
    if (!found || (principal.projectId && found.projectId !== principal.projectId)) return null;
    await tx.updateTable("runs").set({ client_seen_at: sql<Date>`now()` }).where("id", "=", id).where("client_seen_at", "is not", null).where("status", "in", ["queued", "running"]).execute();
    return found;
  });
  if (!summary) return refuse(404, "Run not found.");
  return succeed(runResultOf(summary, deps.baseUrl));
}

export async function stopRunFor(principal: RunPrincipal, id: string, deps: RunApiDeps): Promise<Outcome<{ id: string; status: string; stopped: boolean }>> {
  if (!principal.can.control) return refuse(403, notAllowed(principal));
  if (!UUID.test(id)) return refuse(404, "Run not found.");
  const outcome = await withOrg(deps.db, principal.orgId, async (tx) => {
    const run = await tx.selectFrom("runs").select("project_id").where("id", "=", id).where("org_id", "=", principal.orgId).executeTakeFirst();
    if (!run || (principal.projectId && run.project_id !== principal.projectId)) return null;
    const stopped = await cancelRun(tx, principal.orgId, id, principal.via ? "stopped_over_mcp" : "stopped_from_ci", principal.via);
    const { status } = await tx.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirstOrThrow();
    return { id, status, stopped };
  });
  return outcome ? succeed(outcome) : refuse(404, "Run not found.");
}
