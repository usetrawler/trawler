import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MAX_ACCOUNTS, ProjectConfigSchema, TargetAccountSchema, type Goal, type Persona, type ProjectConfig } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";
import { last4, type Keyring } from "../lib/secrets.ts";

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

async function insertPlan(tx: Tx, orgId: string, projectId: string, personas: Persona[], goals: Goal[], signsIn: ReadonlySet<string> = new Set()) {
  if (personas.length) {
    await tx.insertInto("personas").values(personas.map((p, i) => ({ org_id: orgId, project_id: projectId, key: p.id, name: p.name, brief: p.brief, account_ref: p.accountRef ?? null, signs_in: signsIn.has(p.id) || p.accountRef !== undefined, position: i }))).execute();
  }
  const owned = goalsPerPerson(personas, goals);
  if (owned.length) {
    await tx.insertInto("goals").values(owned.map((g, i) => ({ org_id: orgId, project_id: projectId, key: g.id, instruction: g.instruction, persona_key: g.personaId, position: i }))).execute();
  }
}

const FocusSchema = z.string().trim().max(500).optional();
const FeaturesSchema = z.array(z.string().trim().min(1).max(300)).max(10).default([]);

export async function createProject(tx: Tx, orgId: string, config: ProjectConfig, keys: Keyring, extra: { focus?: string; features?: string[]; signsIn?: string[] } = {}): Promise<string> {
  const valid = ProjectConfigSchema.parse(config);
  const focus = FocusSchema.parse(extra.focus) || null;
  const features = FeaturesSchema.parse(extra.features);
  const { id } = await tx
    .insertInto("projects")
    .values({
      org_id: orgId, name: valid.name, target_url: valid.targetUrl, docs_url: valid.docsUrl ?? null,
      description: valid.description, focus, features, allowed_origins: valid.allowedOrigins,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (valid.accounts.length) {
    await tx.insertInto("target_accounts").values(valid.accounts.map((a, i) => ({
      org_id: orgId, project_id: id, ref: a.ref, username: a.username, position: i,
      password_secret: keys.encrypt(a.password, accountContext(orgId, id, a.ref)), password_hint: last4(a.password),
    }))).execute();
  }
  await insertPlan(tx, orgId, id, valid.personas, valid.goals, new Set(extra.signsIn));
  const gates = [
    ...(valid.httpCredentials ? [{ kind: "basic_auth", name: valid.httpCredentials.username, value: null, secret: valid.httpCredentials.password }] : []),
    ...Object.entries(valid.extraHeaders).map(([name, value]) => ({ kind: "header", name, value, secret: null })),
    ...Object.entries(valid.secretHeaders).map(([name, secret]) => ({ kind: "secret_header", name, value: null, secret })),
  ];
  if (gates.length) {
    await tx.insertInto("target_gates").values(gates.map((g, i) => ({
      org_id: orgId, project_id: id, kind: g.kind, name: g.name, value: g.value, position: i,
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

export async function loadProjectConfig(tx: Tx, orgId: string, projectId: string, keys: Keyring): Promise<ProjectConfig> {
  const project = await tx.selectFrom("projects").selectAll().where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const [personas, goals, accounts, gates] = await Promise.all([
    tx.selectFrom("personas").selectAll().where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("goals").selectAll().where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("target_accounts").selectAll().where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("target_gates").selectAll().where("project_id", "=", projectId).orderBy("position").execute(),
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

export async function projectForEditing(tx: Tx, orgId: string, projectId: string) {
  const project = await tx.selectFrom("projects").select(["id", "name", "target_url", "docs_url", "description", "focus", "features", "allowed_origins"]).where("id", "=", projectId).where("org_id", "=", orgId).executeTakeFirst();
  if (!project) return null;
  const [personas, goals, accounts, gates] = await Promise.all([
    tx.selectFrom("personas").select(["key", "name", "brief", "account_ref", "signs_in"]).where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("goals").select(["key", "instruction", "persona_key"]).where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("target_accounts").select(["ref", "username", "password_hint"]).where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("target_gates").select(["kind", "name", "value", "secret_hint"]).where("project_id", "=", projectId).orderBy("position").execute(),
  ]);
  return { ...project, personas, goals, accounts, gates };
}

export async function replacePlan(tx: Tx, orgId: string, projectId: string, plan: { personas: Persona[]; goals: Goal[] }, signsIn?: string[]): Promise<void> {
  const project = await tx.selectFrom("projects").select("target_url").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const refs = new Set((await tx.selectFrom("target_accounts").select("ref").where("project_id", "=", projectId).execute()).map((a) => a.ref));
  const checked = ProjectConfigSchema.safeParse({
    name: "check", targetUrl: project.target_url, personas: plan.personas, goals: plan.goals,
    accounts: [...refs].map((ref) => ({ ref, username: "u", password: "x".repeat(8) })),
  });
  if (!checked.success) {
    const message = checked.error.issues.map((i) => i.message).join("; ");
    throw checked.error.issues.some((i) => i.path[0] === "personas" && i.path[2] === "accountRef") ? new UnknownAccount(message) : new Error(message);
  }
  const signing = new Set(signsIn ?? (await tx.selectFrom("personas").select("key").where("project_id", "=", projectId).where("signs_in", "=", true).execute()).map((p) => p.key));
  await tx.deleteFrom("goals").where("project_id", "=", projectId).execute();
  await tx.deleteFrom("personas").where("project_id", "=", projectId).execute();
  await insertPlan(tx, orgId, projectId, checked.data.personas, checked.data.goals, signing);
  await tx.updateTable("projects").set({ updated_at: new Date() }).where("id", "=", projectId).execute();
}

export class AccountLimit extends Error {
  constructor() {
    super(`a project can hold at most ${MAX_ACCOUNTS} test accounts`);
  }
}

export class UnknownAccount extends Error {}

export async function addAccount(tx: Tx, orgId: string, projectId: string, input: { username: string; password: string }, keys: Keyring): Promise<string> {
  const project = await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  const existing = await tx.selectFrom("target_accounts").select(["ref", "position"]).where("project_id", "=", projectId).execute();
  if (existing.length >= MAX_ACCOUNTS) throw new AccountLimit();
  const account = TargetAccountSchema.parse({ ref: `account-${randomBytes(6).toString("hex")}`, username: input.username.trim(), password: input.password });
  await tx.insertInto("target_accounts").values({
    org_id: orgId, project_id: projectId, ref: account.ref, username: account.username, position: Math.max(-1, ...existing.map((a) => a.position)) + 1,
    password_secret: keys.encrypt(account.password, accountContext(orgId, projectId, account.ref)), password_hint: last4(account.password),
  }).execute();
  return account.ref;
}

export async function removeAccount(tx: Tx, orgId: string, projectId: string, ref: string): Promise<void> {
  const project = await tx.selectFrom("projects").select("id").where("id", "=", projectId).where("org_id", "=", orgId).forUpdate().executeTakeFirst();
  if (!project) throw new ProjectNotFound();
  await tx.updateTable("personas").set({ account_ref: null }).where("project_id", "=", projectId).where("account_ref", "=", ref).execute();
  await tx.deleteFrom("target_accounts").where("project_id", "=", projectId).where("ref", "=", ref).execute();
}
