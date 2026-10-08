import type { LanguageModel } from "ai";
import { Budget, describeProduct, proposePeople, readProduct, SIGN_UP, type ProductPage, type ProductSummary, type SignUp } from "@usetrawler/core/setup";
import { sql } from "kysely";
import type { Database } from "../db/index.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { createPlan, createProject, MAX_PLANS, nameFree, PlanLimit, planOf, ProjectNotFound, replacePlan } from "../projects/projects.ts";
import { ProjectLimitReached, projectLimitReached } from "../runs/plans.ts";
import { FetchRefused } from "./safe-fetch.ts";
import { writeLog } from "../server/log.ts";
import { WORKING_MINUTES, type SetupProgress } from "./progress.ts";

const SETUP_BUDGET_USD = 0.25;

export interface SetupDeps {
  db: Database;
  keys: Keyring;
  model: LanguageModel;
  modelId: string;
  fetchText: (url: string) => Promise<{ text: string; finalUrl: string }>;
}

export const SETUP_LIMITS = { perTenMinutes: 10, perDay: 100 };

export class SetupLimited extends Error {}

async function claimSetupAttempt(db: Database, orgId: string): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`setup:${orgId}`}, 0))`.execute(tx);
    const counts = await tx
      .selectFrom("setup_attempts")
      .select((eb) => [
        eb.fn.countAll<string>().filterWhere("created_at", ">", sql<Date>`now() - interval '10 minutes'`).as("recent"),
        eb.fn.countAll<string>().as("today"),
      ])
      .where("org_id", "=", orgId)
      .where("created_at", ">", sql<Date>`now() - interval '1 day'`)
      .executeTakeFirstOrThrow();
    if (Number(counts.recent) >= SETUP_LIMITS.perTenMinutes || Number(counts.today) >= SETUP_LIMITS.perDay) {
      throw new SetupLimited("too many new projects in a short time");
    }
    await tx.insertInto("setup_attempts").values({ org_id: orgId }).execute();
  });
}

export class DraftGone extends Error {}

export class SetupStillRunning extends Error {}


const DRAFT_HOURS = 24;
const MAX_OTHER_ORIGINS = 19;

async function draftOf(deps: SetupDeps, orgId: string, draftId: string) {
  const draft = await withOrg(deps.db, orgId, (tx) => tx.selectFrom("setup_drafts").selectAll().where("id", "=", draftId).where("org_id", "=", orgId)
    .where("created_at", ">", sql<Date>`now() - make_interval(hours => ${DRAFT_HOURS})`).executeTakeFirst());
  if (!draft) throw new DraftGone("the setup draft is gone");
  return draft;
}

function summaryOf(draft: { name: string | null; url: string; description: string | null; sign_up: string | null; features: unknown }): ProductSummary {
  return {
    name: draft.name ?? new URL(draft.url).hostname, description: draft.description ?? "",
    signUp: (SIGN_UP as readonly string[]).includes(draft.sign_up ?? "") ? (draft.sign_up as SignUp) : "unclear",
    features: draft.features as ProductSummary["features"],
  };
}

function productOf(draft: { url: string; docs_url: string | null; page: string; docs: string | null }): ProductPage {
  return { url: draft.url, ...(draft.docs_url ? { docsUrl: draft.docs_url } : {}), page: draft.page, ...(draft.docs !== null ? { docs: draft.docs } : {}) };
}

async function refuseAtProjectLimit(deps: SetupDeps, orgId: string): Promise<void> {
  const reached = await withOrg(deps.db, orgId, (tx) => projectLimitReached(tx, orgId));
  if (reached) throw new ProjectLimitReached(reached);
}

export interface DescribedByHand {
  name: string;
  description: string;
}

export async function startDraft(deps: SetupDeps, input: { orgId: string; url?: string; projectId?: string; planId?: string; planName?: string; byHand?: DescribedByHand }): Promise<string> {
  let url = input.url ?? "";
  let docsUrl: string | undefined;
  let known: { name: string; description: string; features: string[] } | undefined;
  if (input.projectId) {
    const project = await withOrg(deps.db, input.orgId, (tx) => tx.selectFrom("projects").select(["target_url", "docs_url", "name", "description", "features"]).where("id", "=", input.projectId!).where("org_id", "=", input.orgId).executeTakeFirst());
    if (!project) throw new ProjectNotFound();
    if (input.planName !== undefined) {
      await withOrg(deps.db, input.orgId, async (tx) => {
        const { n } = await tx.selectFrom("plans").select(sql<string>`count(*)`.as("n")).where("project_id", "=", input.projectId!).where("kind", "=", "standard").executeTakeFirstOrThrow();
        if (Number(n) >= MAX_PLANS) throw new PlanLimit();
        await nameFree(tx, input.projectId!, input.planName!.trim());
      });
    }
    else if (input.planId !== undefined) await withOrg(deps.db, input.orgId, (tx) => planOf(tx, input.orgId, input.projectId!, input.planId));
    url = project.target_url;
    docsUrl = project.docs_url ?? undefined;
    const plans = await withOrg(deps.db, input.orgId, (tx) => tx.selectFrom("plans").select(["id", "features"]).where("project_id", "=", input.projectId!).where("kind", "=", "standard").orderBy("position").orderBy("created_at").execute());
    const plan = plans.find((p) => p.id === input.planId) ?? plans[0];
    known = { name: project.name, description: project.description, features: plan?.features ?? project.features };
  } else {
    await refuseAtProjectLimit(deps, input.orgId);
  }
  await claimSetupAttempt(deps.db, input.orgId);
  const productUrl = URL.canParse(url) ? new URL(url).href : url;
  const origins = new Set<string>();
  let refusal: FetchRefused | undefined;
  let product: ProductPage;
  if (input.byHand && !input.projectId) return draftByHand(deps, input.orgId, productUrl, input.byHand);
  try {
    product = await readProduct({
      url,
      docsUrl,
      fetchText: async (u) => {
        try {
          const { text, finalUrl } = await deps.fetchText(u);
          origins.add(new URL(finalUrl).origin);
          return text;
        } catch (err) {
          if (err instanceof FetchRefused && u === productUrl) refusal = err;
          throw err;
        }
      },
    });
  } catch (err) {
    if (refusal?.reason === "private" && known && input.projectId) return draftFromProject(deps, input, productUrl, known);
    throw refusal ?? err;
  }
  await asSystem(deps.db, (tx) => tx.deleteFrom("setup_drafts").where("created_at", "<", sql<Date>`now() - make_interval(hours => ${DRAFT_HOURS})`).execute());
  return withOrg(deps.db, input.orgId, async (tx) => {
    const { id } = await tx.insertInto("setup_drafts").values({
      org_id: input.orgId, project_id: input.projectId ?? null, plan_id: input.planName === undefined ? input.planId ?? null : null, new_plan_name: input.planName?.trim() ?? null, url: product.url, docs_url: product.docsUrl ?? null, page: product.page, docs: product.docs ?? null, origins: [...origins],
    }).returning("id").executeTakeFirstOrThrow();
    return id;
  });
}

async function draftFromProject(deps: SetupDeps, input: { orgId: string; projectId?: string; planId?: string; planName?: string }, url: string, known: { name: string; description: string; features: string[] }): Promise<string> {
  return withOrg(deps.db, input.orgId, async (tx) => {
    const { id } = await tx.insertInto("setup_drafts").values({
      org_id: input.orgId, project_id: input.projectId ?? null, plan_id: input.planName === undefined ? input.planId ?? null : null, new_plan_name: input.planName?.trim() ?? null,
      url, page: "", name: known.name, description: known.description, sign_up: "unclear", features: JSON.stringify(known.features.map((title) => ({ title, summary: "" }))), described_at: new Date(),
    }).returning("id").executeTakeFirstOrThrow();
    return id;
  });
}

async function draftByHand(deps: SetupDeps, orgId: string, url: string, byHand: DescribedByHand): Promise<string> {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new FetchRefused("address", "not a web address");
  return withOrg(deps.db, orgId, async (tx) => {
    const { id } = await tx.insertInto("setup_drafts").values({
      org_id: orgId, url, page: "", name: byHand.name.trim(), description: byHand.description.trim(), sign_up: "unclear", features: JSON.stringify([]), described_at: new Date(),
    }).returning("id").executeTakeFirstOrThrow();
    return id;
  });
}

export async function describeDraft(deps: SetupDeps, input: { orgId: string; draftId: string }): Promise<ProductSummary> {
  const draft = await draftOf(deps, input.orgId, input.draftId);
  const claimed = await withOrg(deps.db, input.orgId, (tx) => tx.updateTable("setup_drafts").set({ described_at: new Date() }).where("id", "=", draft.id).where("described_at", "is", null).returning("id").executeTakeFirst());
  if (!claimed) {
    const described = await draftOf(deps, input.orgId, input.draftId);
    if (!described.features) throw new DraftGone("the setup draft was already described without a result");
    return summaryOf(described);
  }
  let summary: ProductSummary;
  const started = Date.now();
  try {
    const described = await describeProduct({ model: deps.model, modelId: deps.modelId, budget: new Budget(SETUP_BUDGET_USD), product: productOf(draft) });
    summary = described.summary;
    const { usage } = described;
    void writeLog("info", "setup described the product", { orgId: input.orgId, seconds: (Date.now() - started) / 1000, model: usage.model, tries: usage.steps, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd }).catch(() => undefined);
  } catch (err) {
    await withOrg(deps.db, input.orgId, (tx) => tx.updateTable("setup_drafts").set({ describe_failed_at: sql<Date>`now()` }).where("id", "=", draft.id).execute()).catch(() => undefined);
    throw err;
  }
  await withOrg(deps.db, input.orgId, (tx) => tx.updateTable("setup_drafts").set({ name: summary.name, description: summary.description, sign_up: summary.signUp, features: JSON.stringify(summary.features) }).where("id", "=", draft.id).execute());
  return summary;
}

async function claimProposal(deps: SetupDeps, orgId: string, draftId: string): Promise<boolean> {
  const claimed = await withOrg(deps.db, orgId, (tx) => tx.updateTable("setup_drafts").set({ proposing_at: sql<Date>`now()` })
    .where("id", "=", draftId).where("result_project_id", "is", null)
    .where((eb) => eb.or([eb("proposing_at", "is", null), eb("proposing_at", "<", sql<Date>`now() - make_interval(mins => ${WORKING_MINUTES})`)]))
    .returning("id").executeTakeFirst());
  return Boolean(claimed);
}

async function releaseProposal(deps: SetupDeps, orgId: string, draftId: string): Promise<void> {
  await withOrg(deps.db, orgId, (tx) => tx.updateTable("setup_drafts").set({ proposing_at: null }).where("id", "=", draftId).where("result_project_id", "is", null).execute());
}

export interface Proposed {
  projectId: string;
  planId: string | null;
}

export async function proposeFromDraft(deps: SetupDeps, input: { orgId: string; draftId: string; description: string; features: string[]; signUp?: SignUp }): Promise<Proposed> {
  const draft = await draftOf(deps, input.orgId, input.draftId);
  if (draft.result_project_id) return { projectId: draft.result_project_id, planId: draft.result_plan_id };
  if (!draft.project_id) await refuseAtProjectLimit(deps, input.orgId);
  if (!(await claimProposal(deps, input.orgId, draft.id))) {
    const now = await draftOf(deps, input.orgId, input.draftId);
    if (now.result_project_id) return { projectId: now.result_project_id, planId: now.result_plan_id };
    throw new SetupStillRunning("the people for this setup are still being chosen");
  }
  try {
    await claimSetupAttempt(deps.db, input.orgId);
    return await proposeClaimed(deps, input, draft);
  } catch (err) {
    await releaseProposal(deps, input.orgId, draft.id).catch(() => undefined);
    throw err;
  }
}

async function proposeClaimed(deps: SetupDeps, input: { orgId: string; description: string; features: string[]; signUp?: SignUp }, draft: Awaited<ReturnType<typeof draftOf>>): Promise<Proposed> {
  const product = productOf(draft);
  const started = Date.now();
  const { project, signsIn, usage } = await proposePeople({
    model: deps.model, modelId: deps.modelId, budget: new Budget(SETUP_BUDGET_USD), product,
    name: draft.name ?? new URL(draft.url).hostname, description: input.description, features: input.features, signUp: input.signUp,
  });
  void writeLog("info", "setup chose the people", { orgId: input.orgId, seconds: (Date.now() - started) / 1000, model: usage.model, tries: usage.steps, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd, people: project.personas.length, goals: project.goals.length }).catch(() => undefined);
  const features = input.features.map((f) => f.trim()).filter(Boolean);
  return withOrg(deps.db, input.orgId, async (tx) => {
    if (draft.project_id) await tx.selectFrom("projects").select("id").where("id", "=", draft.project_id).where("org_id", "=", input.orgId).forUpdate().execute();
    const taken = await tx.selectFrom("setup_drafts").select(["id", "result_project_id", "result_plan_id"]).where("id", "=", draft.id).forUpdate().executeTakeFirst();
    if (!taken) throw new DraftGone("the setup draft is gone");
    if (taken.result_project_id) return { projectId: taken.result_project_id, planId: taken.result_plan_id };
    let projectId = draft.project_id;
    let planId: string | null = null;
    if (projectId) {
      if (draft.new_plan_name) {
        planId = (await createPlan(tx, input.orgId, projectId, { name: draft.new_plan_name, features, personas: project.personas, goals: project.goals, signsIn })).id;
      } else {
        planId = (await planOf(tx, input.orgId, projectId, draft.plan_id ?? undefined)).id;
        const before = await tx.selectFrom("personas").select(["key", "account_ref"]).where("plan_id", "=", planId).execute();
        const accountOf = new Map(before.map((p) => [p.key, p.account_ref]));
        const personas = project.personas.map((p) => (accountOf.get(p.id) ? { ...p, accountRef: accountOf.get(p.id)! } : p));
        await replacePlan(tx, input.orgId, projectId, { personas, goals: project.goals }, signsIn, { planId, features });
      }
      const current = await tx.selectFrom("projects").select("allowed_origins").where("id", "=", projectId).executeTakeFirstOrThrow();
      const target = new URL(draft.url).origin;
      const allowedOrigins = [...current.allowed_origins];
      for (const origin of draft.origins) {
        if (origin !== target && !allowedOrigins.includes(origin) && allowedOrigins.length < MAX_OTHER_ORIGINS) allowedOrigins.push(origin);
      }
      await tx.updateTable("projects").set({ description: project.description, allowed_origins: allowedOrigins }).where("id", "=", projectId).execute();
    } else {
      const config = { ...project, allowedOrigins: [...new Set([...project.allowedOrigins, ...draft.origins])] };
      projectId = await createProject(tx, input.orgId, config, deps.keys, { features, signsIn });
    }
    await tx.updateTable("setup_drafts").set({ result_project_id: projectId, result_plan_id: planId, page: "", docs: null }).where("id", "=", draft.id).execute();
    return { projectId, planId };
  });
}

const recent = (at: Date | null) => at !== null && Date.now() - at.getTime() < WORKING_MINUTES * 60_000;

export async function setupProgress(deps: Pick<SetupDeps, "db">, input: { orgId: string; draftId: string }): Promise<SetupProgress> {
  const draft = await withOrg(deps.db, input.orgId, (tx) => tx.selectFrom("setup_drafts").selectAll().where("id", "=", input.draftId).where("org_id", "=", input.orgId)
    .where("created_at", ">", sql<Date>`now() - make_interval(hours => ${DRAFT_HOURS})`).executeTakeFirst());
  if (!draft) return { state: "gone" };
  if (draft.result_project_id) return { state: "project", projectId: draft.result_project_id, ...(draft.result_plan_id ? { planId: draft.result_plan_id } : {}) };
  if (recent(draft.proposing_at)) return { state: "working" };
  if (draft.features) return { state: "described", summary: summaryOf(draft) };
  if (draft.describe_failed_at) return { state: "failed" };
  return recent(draft.described_at) ? { state: "working" } : { state: "gone" };
}
