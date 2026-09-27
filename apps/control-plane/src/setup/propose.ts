import type { LanguageModel } from "ai";
import { Budget, describeProduct, proposePeople, readProduct, type ProductPage, type ProductSummary } from "@usetrawler/core/setup";
import { sql } from "kysely";
import type { Database } from "../db/index.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { createProject, ProjectNotFound, replacePlan } from "../projects/projects.ts";
import { FetchRefused } from "./safe-fetch.ts";

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

const DRAFT_HOURS = 24;

async function draftOf(deps: SetupDeps, orgId: string, draftId: string) {
  const draft = await withOrg(deps.db, orgId, (tx) => tx.selectFrom("setup_drafts").selectAll().where("id", "=", draftId).where("org_id", "=", orgId)
    .where("created_at", ">", sql<Date>`now() - make_interval(hours => ${DRAFT_HOURS})`).executeTakeFirst());
  if (!draft) throw new DraftGone("the setup draft is gone");
  return draft;
}

function productOf(draft: { url: string; docs_url: string | null; page: string; docs: string | null }): ProductPage {
  return { url: draft.url, ...(draft.docs_url ? { docsUrl: draft.docs_url } : {}), page: draft.page, ...(draft.docs !== null ? { docs: draft.docs } : {}) };
}

export async function startDraft(deps: SetupDeps, input: { orgId: string; url?: string; projectId?: string }): Promise<string> {
  let url = input.url ?? "";
  let docsUrl: string | undefined;
  if (input.projectId) {
    const project = await withOrg(deps.db, input.orgId, (tx) => tx.selectFrom("projects").select(["target_url", "docs_url"]).where("id", "=", input.projectId!).where("org_id", "=", input.orgId).executeTakeFirst());
    if (!project) throw new ProjectNotFound();
    url = project.target_url;
    docsUrl = project.docs_url ?? undefined;
  }
  await claimSetupAttempt(deps.db, input.orgId);
  const productUrl = URL.canParse(url) ? new URL(url).href : url;
  const origins = new Set<string>();
  let refusal: FetchRefused | undefined;
  let product: ProductPage;
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
    throw refusal ?? err;
  }
  await asSystem(deps.db, (tx) => tx.deleteFrom("setup_drafts").where("created_at", "<", sql<Date>`now() - make_interval(hours => ${DRAFT_HOURS})`).execute());
  return withOrg(deps.db, input.orgId, async (tx) => {
    const { id } = await tx.insertInto("setup_drafts").values({
      org_id: input.orgId, project_id: input.projectId ?? null, url: product.url, docs_url: product.docsUrl ?? null, page: product.page, docs: product.docs ?? null, origins: [...origins],
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
    return { name: described.name ?? new URL(described.url).hostname, description: described.description ?? "", features: described.features as unknown as ProductSummary["features"] };
  }
  const { summary } = await describeProduct({ model: deps.model, modelId: deps.modelId, budget: new Budget(SETUP_BUDGET_USD), product: productOf(draft) });
  await withOrg(deps.db, input.orgId, (tx) => tx.updateTable("setup_drafts").set({ name: summary.name, description: summary.description, features: JSON.stringify(summary.features) }).where("id", "=", draft.id).execute());
  return summary;
}

export async function proposeFromDraft(deps: SetupDeps, input: { orgId: string; draftId: string; description: string; features: string[] }): Promise<string> {
  const draft = await draftOf(deps, input.orgId, input.draftId);
  await claimSetupAttempt(deps.db, input.orgId);
  const product = productOf(draft);
  const { project, signsIn } = await proposePeople({
    model: deps.model, modelId: deps.modelId, budget: new Budget(SETUP_BUDGET_USD), product,
    name: draft.name ?? new URL(draft.url).hostname, description: input.description, features: input.features,
  });
  const features = input.features.map((f) => f.trim()).filter(Boolean);
  return withOrg(deps.db, input.orgId, async (tx) => {
    const taken = await tx.deleteFrom("setup_drafts").where("id", "=", draft.id).returning("id").executeTakeFirst();
    if (!taken) throw new DraftGone("the setup draft was already used");
    let projectId = draft.project_id;
    if (projectId) {
      const before = await tx.selectFrom("personas").select(["key", "account_ref"]).where("project_id", "=", projectId).execute();
      const accountOf = new Map(before.map((p) => [p.key, p.account_ref]));
      const personas = project.personas.map((p) => (accountOf.get(p.id) ? { ...p, accountRef: accountOf.get(p.id)! } : p));
      await replacePlan(tx, input.orgId, projectId, { personas, goals: project.goals }, signsIn);
      const current = await tx.selectFrom("projects").select("allowed_origins").where("id", "=", projectId).executeTakeFirstOrThrow();
      const allowedOrigins = [...new Set([...current.allowed_origins, ...draft.origins])].slice(0, 20);
      await tx.updateTable("projects").set({ description: project.description, features, allowed_origins: allowedOrigins }).where("id", "=", projectId).execute();
    } else {
      const config = { ...project, allowedOrigins: [...new Set([...project.allowedOrigins, ...draft.origins])] };
      projectId = await createProject(tx, input.orgId, config, deps.keys, { features, signsIn });
    }
    return projectId;
  });
}
