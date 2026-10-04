import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { MAX_ACCOUNTS, ProjectConfigSchema, TargetAccountSchema, type Goal, type Persona, type ProjectConfig } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";
import { last4, type Keyring } from "../lib/secrets.ts";
import { claimProjectSlot } from "../runs/plans.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const accountContext = (orgId: string, projectId: string, ref: string) => [orgId, "target_account", projectId, ref, "password"];
const gateContext = (orgId: string, projectId: string, kind: string, name: string) => [orgId, "target_gate", projectId, kind, kind === "basic_auth" ? "password" : name];

export function goalsPerPerson(personas: Persona[], goals: Goal[]): (Goal & { personaId: string })[] {
  const taken = new Set(goals.map((g) => g.id));
  return goals.flatMap((g) => {
    if (g.personaId !== undefined) return [{ ...g, personaId: g.personaId }];
    return personas.map((p, i) => {
      if (i === 0) return { ...g, personaId: p.id };
      const base = `${g.id.slice(0, 30)}-${p.id.slice(0, 26)}`;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
      return { ...g, id, personaId: p.id };
    });
  });
}

export async function firstPlan(tx: Tx, orgId: string, projectId: string): Promise<{ id: string; name: string }> {
  const plan = await tx.selectFrom("plans").select(["id", "name"]).where("project_id", "=", projectId).where("org_id", "=", orgId).orderBy("position").orderBy("created_at").orderBy("id").executeTakeFirst();
  if (!plan) throw new ProjectNotFound();
  return plan;
}

export const MAX_PLANS = 10;

export class PlanNotFound extends Error {
  constructor() {
    super("plan not found");
  }
}

export class PlanNameTaken extends Error {
  constructor() {
    super("another plan of this project already has that name");
  }
}

export class PlanLimit extends Error {
  constructor() {
    super(`a project can hold at most ${MAX_PLANS} plans`);
  }
}

export class LastPlan extends Error {
  constructor() {
    super("a project keeps at least one plan");
  }
}

export class PlanInUse extends Error {
  constructor() {
    super("a run of this plan is queued or running");
  }
}

const PlanNameSchema = z.string().trim().min(1).max(100);

export async function planOf(tx: Tx, orgId: string, projectId: string, planId?: string): Promise<{ id: string; name: string }> {
  if (planId === undefined) return firstPlan(tx, orgId, projectId);
  if (!UUID.test(planId)) throw new PlanNotFound();
  const plan = await tx.selectFrom("plans").select(["id", "name"]).where("id", "=", planId).where("project_id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!plan) throw new PlanNotFound();
  return plan;
}

export async function listPlans(tx: Tx, orgId: string, projectId: string): Promise<{ id: string; name: string; features: string[]; people: number }[]> {
  const plans = await tx.selectFrom("plans").select(["id", "name", "features"]).where("project_id", "=", projectId).where("org_id", "=", orgId).orderBy("position").orderBy("created_at").orderBy("id").execute();
  const counts = await tx.selectFrom("personas").select(["plan_id", sql<string>`count(*)`.as("n")]).where("project_id", "=", projectId).groupBy("plan_id").execute();
  const people = new Map(counts.map((c) => [c.plan_id, Number(c.n)]));
  return plans.map((p) => ({ ...p, people: people.get(p.id) ?? 0 }));
}

export async function nextPlanName(tx: Tx, orgId: string, projectId: string): Promise<string> {
  const taken = new Set((await tx.selectFrom("plans").select("name").where("project_id", "=", projectId).where("org_id", "=", orgId).execute()).map((p) => p.name.toLowerCase()));
  let n = taken.size + 1;
  while (taken.has(`plan ${n}`)) n++;
  return `Plan ${n}`;
}

export async function nameFree(tx: Tx, projectId: string, name: string, except?: string): Promise<void> {
  let query = tx.selectFrom("plans").select("id").where("project_id", "=", projectId).where(sql<boolean>`lower(name) = lower(${name})`);
  if (except) query = query.where("id", "<>", except);
  if (await query.executeTakeFirst()) throw new PlanNameTaken();
}

async function insertPlan(tx: Tx, orgId: string, projectId: string, planId: string, personas: Persona[], goals: Goal[], signsIn: ReadonlySet<string> = new Set()) {
  if (personas.length) {
    await tx.insertInto("personas").values(personas.map((p, i) => ({ org_id: orgId, project_id: projectId, plan_id: planId, key: p.id, name: p.name, brief: p.brief, account_ref: p.accountRef ?? null, signs_in: signsIn.has(p.id) || p.accountRef !== undefined, position: i }))).execute();
  }
  const owned = goalsPerPerson(personas, goals);
  if (owned.length) {
    await tx.insertInto("goals").values(owned.map((g, i) => ({ org_id: orgId, project_id: projectId, plan_id: planId, key: g.id, instruction: g.instruction, persona_key: g.personaId, position: i }))).execute();
  }
}

const FocusSchema = z.string().trim().max(500).optional();
const FeaturesSchema = z.array(z.string().trim().min(1).max(300)).max(10).default([]);

export async function createProject(tx: Tx, orgId: string, config: ProjectConfig, keys: Keyring, extra: { focus?: string; features?: string[]; signsIn?: string[]; demo?: boolean } = {}): Promise<string> {
  const valid = ProjectConfigSchema.parse(config);
  const focus = FocusSchema.parse(extra.focus) || null;
  const features = FeaturesSchema.parse(extra.features);
  const demo = extra.demo ?? false;
  if (!demo) await claimProjectSlot(tx, orgId);
  const { id } = await tx
    .insertInto("projects")
    .values({
      org_id: orgId, name: valid.name, target_url: valid.targetUrl, docs_url: valid.docsUrl ?? null,
      description: valid.description, focus, allowed_origins: valid.allowedOrigins, demo,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { id: planId } = await tx.insertInto("plans").values({ org_id: orgId, project_id: id, name: focus?.slice(0, 100) || "Plan 1", features }).returning("id").executeTakeFirstOrThrow();
  if (valid.accounts.length) {
    await tx.insertInto("target_accounts").values(valid.accounts.map((a, i) => ({
      org_id: orgId, project_id: id, plan_id: planId, ref: a.ref, username: a.username, position: i,
      password_secret: keys.encrypt(a.password, accountContext(orgId, id, a.ref)), password_hint: last4(a.password),
    }))).execute();
  }
  await insertPlan(tx, orgId, id, planId, valid.personas, valid.goals, new Set(extra.signsIn));
  const gates = [
    ...(valid.httpCredentials ? [{ kind: "basic_auth", name: valid.httpCredentials.username, value: null, secret: valid.httpCredentials.password }] : []),
    ...Object.entries(valid.extraHeaders).map(([name, value]) => ({ kind: "header", name, value, secret: null })),
    ...Object.entries(valid.secretHeaders).map(([name, secret]) => ({ kind: "secret_header", name, value: null, secret })),
  ];
  if (gates.length) {
    await tx.insertInto("target_gates").values(gates.map((g, i) => ({
      org_id: orgId, project_id: id, plan_id: planId, kind: g.kind, name: g.name, value: g.value, position: i,
      secret: g.secret === null ? null : keys.encrypt(g.secret, gateContext(orgId, id, g.kind, g.name)),
      secret_hint: g.secret === null ? null : last4(g.secret),
    }))).execute();
  }
  return id;
}

export class ProjectNotFound extends Error {
  constructor() {
    super("project not found");
  }
}

export async function loadProjectConfig(tx: Tx, orgId: string, projectId: string, keys: Keyring, planId?: string): Promise<ProjectConfig> {
  const project = await tx.selectFrom("projects").selectAll().where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const plan = await planOf(tx, orgId, projectId, planId);
  const [personas, goals, accounts, gates] = await Promise.all([
    tx.selectFrom("personas").selectAll().where("plan_id", "=", plan.id).orderBy("position").execute(),
    tx.selectFrom("goals").selectAll().where("plan_id", "=", plan.id).orderBy("position").execute(),
    tx.selectFrom("target_accounts").selectAll().where("plan_id", "=", plan.id).orderBy("position").execute(),
    tx.selectFrom("target_gates").selectAll().where("plan_id", "=", plan.id).orderBy("position").execute(),
  ]);
  const basic = gates.find((g) => g.kind === "basic_auth");
  return ProjectConfigSchema.parse({
    name: project.name,
    targetUrl: project.target_url,
    ...(project.docs_url ? { docsUrl: project.docs_url } : {}),
    description: project.description,
    allowedOrigins: project.allowed_origins,
    personas: personas.map((p) => ({ id: p.key, name: p.name, brief: p.brief, ...(p.account_ref ? { accountRef: p.account_ref } : {}) })),
    goals: goals.map((g) => ({ id: g.key, instruction: g.instruction, personaId: g.persona_key })),
    accounts: accounts.map((a) => ({ ref: a.ref, username: a.username, password: keys.decrypt(a.password_secret, accountContext(orgId, projectId, a.ref)) })),
    ...(basic ? { httpCredentials: { username: basic.name, password: keys.decrypt(basic.secret!, gateContext(orgId, projectId, "basic_auth", basic.name)) } } : {}),
    extraHeaders: Object.fromEntries(gates.filter((g) => g.kind === "header").map((g) => [g.name, g.value ?? ""])),
    secretHeaders: Object.fromEntries(gates.filter((g) => g.kind === "secret_header").map((g) => [g.name, keys.decrypt(g.secret!, gateContext(orgId, projectId, "secret_header", g.name))])),
  });
}

export async function projectExists(tx: Tx, orgId: string, projectId: string): Promise<boolean> {
  return !!(await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst());
}

export async function listProjects(tx: Tx, orgId: string) {
  return tx.selectFrom("projects").select(["id", "name", "target_url", "created_at"]).where("org_id", "=", orgId).orderBy("created_at", "desc").orderBy("id").execute();
}

export async function projectForEditing(tx: Tx, orgId: string, projectId: string, planId?: string) {
  const project = await tx.selectFrom("projects").select(["id", "name", "target_url", "docs_url", "description", "focus", "allowed_origins"]).where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!project) return null;
  const found = await planOf(tx, orgId, projectId, planId).catch((err: unknown) => (err instanceof PlanNotFound ? null : Promise.reject(err)));
  if (!found) return null;
  const plan = await tx.selectFrom("plans").select(["id", "name", "features"]).where("id", "=", found.id).executeTakeFirstOrThrow();
  const [personas, goals, accounts, gates] = await Promise.all([
    tx.selectFrom("personas").select(["key", "name", "brief", "account_ref", "signs_in"]).where("plan_id", "=", plan.id).orderBy("position").execute(),
    tx.selectFrom("goals").select(["key", "instruction", "persona_key"]).where("plan_id", "=", plan.id).orderBy("position").execute(),
    tx.selectFrom("target_accounts").select(["ref", "username", "password_hint"]).where("plan_id", "=", plan.id).orderBy("position").execute(),
    tx.selectFrom("target_gates").select(["kind", "name", "value", "secret_hint"]).where("plan_id", "=", plan.id).orderBy("position").execute(),
  ]);
  return { ...project, plan: { id: plan.id, name: plan.name }, features: plan.features, personas, goals, accounts, gates };
}

async function checkedPlan(targetUrl: string, plan: { personas: Persona[]; goals: Goal[] }, refs: Iterable<string>) {
  const checked = ProjectConfigSchema.safeParse({
    name: "check", targetUrl, personas: plan.personas, goals: plan.goals,
    accounts: [...refs].map((ref) => ({ ref, username: "u", password: "x".repeat(8) })),
  });
  if (!checked.success) {
    const message = checked.error.issues.map((i) => i.message).join("; ");
    throw checked.error.issues.some((i) => i.path[0] === "personas" && i.path[2] === "accountRef") ? new UnknownAccount(message) : new Error(message);
  }
  return checked.data;
}

export async function replacePlan(tx: Tx, orgId: string, projectId: string, plan: { personas: Persona[]; goals: Goal[] }, signsIn?: string[], target: { planId?: string; features?: string[] } = {}): Promise<void> {
  const project = await tx.selectFrom("projects").select("target_url").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const { id: planId } = await planOf(tx, orgId, projectId, target.planId);
  const refs = (await tx.selectFrom("target_accounts").select("ref").where("plan_id", "=", planId).execute()).map((a) => a.ref);
  const checked = await checkedPlan(project.target_url, plan, refs);
  const signing = new Set(signsIn ?? (await tx.selectFrom("personas").select("key").where("plan_id", "=", planId).where("signs_in", "=", true).execute()).map((p) => p.key));
  await tx.deleteFrom("goals").where("plan_id", "=", planId).execute();
  await tx.deleteFrom("personas").where("plan_id", "=", planId).execute();
  await insertPlan(tx, orgId, projectId, planId, checked.personas, checked.goals, signing);
  await tx.updateTable("plans").set({ updated_at: new Date(), ...(target.features ? { features: FeaturesSchema.parse(target.features) } : {}) }).where("id", "=", planId).execute();
  await tx.updateTable("projects").set({ updated_at: new Date() }).where("id", "=", projectId).execute();
}

export async function createPlan(tx: Tx, orgId: string, projectId: string, input: { name: string; features?: string[]; personas: Persona[]; goals: Goal[]; signsIn?: string[] }): Promise<{ id: string; name: string }> {
  const project = await tx.selectFrom("projects").select("target_url").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const name = PlanNameSchema.parse(input.name);
  const existing = await tx.selectFrom("plans").select("position").where("project_id", "=", projectId).execute();
  if (existing.length >= MAX_PLANS) throw new PlanLimit();
  await nameFree(tx, projectId, name);
  const checked = await checkedPlan(project.target_url, input, []);
  const { id } = await tx.insertInto("plans").values({ org_id: orgId, project_id: projectId, name, position: Math.max(-1, ...existing.map((p) => p.position)) + 1, features: FeaturesSchema.parse(input.features) }).returning("id").executeTakeFirstOrThrow();
  await insertPlan(tx, orgId, projectId, id, checked.personas, checked.goals, new Set(input.signsIn));
  await tx.updateTable("projects").set({ updated_at: new Date() }).where("id", "=", projectId).execute();
  return { id, name };
}

export async function renamePlan(tx: Tx, orgId: string, projectId: string, planId: string, name: string): Promise<string> {
  if (!(await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst())) throw new ProjectNotFound();
  const plan = await planOf(tx, orgId, projectId, planId);
  const clean = PlanNameSchema.parse(name);
  await nameFree(tx, projectId, clean, plan.id);
  await tx.updateTable("plans").set({ name: clean, updated_at: new Date() }).where("id", "=", plan.id).execute();
  return clean;
}

export async function removePlan(tx: Tx, orgId: string, projectId: string, planId: string): Promise<void> {
  if (!(await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst())) throw new ProjectNotFound();
  const plan = await planOf(tx, orgId, projectId, planId);
  const { n } = await tx.selectFrom("plans").select(sql<string>`count(*)`.as("n")).where("project_id", "=", projectId).executeTakeFirstOrThrow();
  if (Number(n) <= 1) throw new LastPlan();
  const live = await tx.selectFrom("runs").select("id").where("plan_id", "=", plan.id).where("status", "in", ["queued", "running"]).executeTakeFirst();
  if (live) throw new PlanInUse();
  await tx.deleteFrom("plans").where("id", "=", plan.id).execute();
}

export class AccountLimit extends Error {
  constructor() {
    super(`a project can hold at most ${MAX_ACCOUNTS} test accounts`);
  }
}

export class UnknownAccount extends Error {}

export async function addAccount(tx: Tx, orgId: string, projectId: string, input: { username: string; password: string }, keys: Keyring, targetPlanId?: string): Promise<string> {
  const project = await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const { id: planId } = await planOf(tx, orgId, projectId, targetPlanId);
  const existing = await tx.selectFrom("target_accounts").select(["ref", "position"]).where("plan_id", "=", planId).execute();
  if (existing.length >= MAX_ACCOUNTS) throw new AccountLimit();
  const account = TargetAccountSchema.parse({ ref: `account-${randomBytes(6).toString("hex")}`, username: input.username.trim(), password: input.password });
  await tx.insertInto("target_accounts").values({
    org_id: orgId, project_id: projectId, plan_id: planId, ref: account.ref, username: account.username, position: Math.max(-1, ...existing.map((a) => a.position)) + 1,
    password_secret: keys.encrypt(account.password, accountContext(orgId, projectId, account.ref)), password_hint: last4(account.password),
  }).execute();
  return account.ref;
}

export async function removeAccount(tx: Tx, orgId: string, projectId: string, ref: string, targetPlanId?: string): Promise<void> {
  const project = await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const { id: planId } = await planOf(tx, orgId, projectId, targetPlanId);
  await tx.updateTable("personas").set({ account_ref: null }).where("plan_id", "=", planId).where("account_ref", "=", ref).execute();
  await tx.deleteFrom("target_accounts").where("plan_id", "=", planId).where("ref", "=", ref).execute();
}
