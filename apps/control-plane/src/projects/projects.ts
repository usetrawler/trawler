import { ProjectConfigSchema, type Goal, type Persona, type ProjectConfig } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";
import { last4, type Keyring } from "../lib/secrets.ts";

const accountContext = (orgId: string, projectId: string, ref: string) => [orgId, "target_account", projectId, ref, "password"];
const gateContext = (orgId: string, projectId: string, kind: string, name: string) => [orgId, "target_gate", projectId, kind, name];

async function insertPlan(tx: Tx, orgId: string, projectId: string, personas: Persona[], goals: Goal[]) {
  if (personas.length) {
    await tx.insertInto("personas").values(personas.map((p, i) => ({ org_id: orgId, project_id: projectId, key: p.id, name: p.name, brief: p.brief, account_ref: p.accountRef ?? null, position: i }))).execute();
  }
  if (goals.length) {
    await tx.insertInto("goals").values(goals.map((g, i) => ({ org_id: orgId, project_id: projectId, key: g.id, instruction: g.instruction, position: i }))).execute();
  }
}

export async function createProject(tx: Tx, orgId: string, config: ProjectConfig, keys: Keyring, extra: { focus?: string } = {}): Promise<string> {
  const valid = ProjectConfigSchema.parse(config);
  const { id } = await tx
    .insertInto("projects")
    .values({
      org_id: orgId, name: valid.name, target_url: valid.targetUrl, docs_url: valid.docsUrl ?? null,
      description: valid.description, focus: extra.focus ?? null, allowed_origins: valid.allowedOrigins,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await insertPlan(tx, orgId, id, valid.personas, valid.goals);
  if (valid.accounts.length) {
    await tx.insertInto("target_accounts").values(valid.accounts.map((a) => ({
      org_id: orgId, project_id: id, ref: a.ref, username: a.username,
      password_secret: keys.encrypt(a.password, accountContext(orgId, id, a.ref)), password_hint: last4(a.password),
    }))).execute();
  }
  const gates = [
    ...(valid.httpCredentials ? [{ kind: "basic_auth", name: valid.httpCredentials.username, value: null, secret: valid.httpCredentials.password }] : []),
    ...Object.entries(valid.extraHeaders).map(([name, value]) => ({ kind: "header", name, value, secret: null })),
    ...Object.entries(valid.secretHeaders).map(([name, secret]) => ({ kind: "secret_header", name, value: null, secret })),
  ];
  if (gates.length) {
    await tx.insertInto("target_gates").values(gates.map((g) => ({
      org_id: orgId, project_id: id, kind: g.kind, name: g.name, value: g.value,
      secret: g.secret === null ? null : keys.encrypt(g.secret, gateContext(orgId, id, g.kind, g.name)),
      secret_hint: g.secret === null ? null : last4(g.secret),
    }))).execute();
  }
  return id;
}

export async function loadProjectConfig(tx: Tx, orgId: string, projectId: string, keys: Keyring): Promise<ProjectConfig> {
  const project = await tx.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  if (!project) throw new Error("project not found");
  const [personas, goals, accounts, gates] = await Promise.all([
    tx.selectFrom("personas").selectAll().where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("goals").selectAll().where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("target_accounts").selectAll().where("project_id", "=", projectId).orderBy("ref").execute(),
    tx.selectFrom("target_gates").selectAll().where("project_id", "=", projectId).orderBy("name").execute(),
  ]);
  const basic = gates.find((g) => g.kind === "basic_auth");
  return ProjectConfigSchema.parse({
    name: project.name,
    targetUrl: project.target_url,
    ...(project.docs_url ? { docsUrl: project.docs_url } : {}),
    description: project.description,
    allowedOrigins: project.allowed_origins,
    personas: personas.map((p) => ({ id: p.key, name: p.name, brief: p.brief, ...(p.account_ref ? { accountRef: p.account_ref } : {}) })),
    goals: goals.map((g) => ({ id: g.key, instruction: g.instruction })),
    accounts: accounts.map((a) => ({ ref: a.ref, username: a.username, password: keys.decrypt(a.password_secret, accountContext(orgId, projectId, a.ref)) })),
    ...(basic ? { httpCredentials: { username: basic.name, password: keys.decrypt(basic.secret!, gateContext(orgId, projectId, "basic_auth", basic.name)) } } : {}),
    extraHeaders: Object.fromEntries(gates.filter((g) => g.kind === "header").map((g) => [g.name, g.value ?? ""])),
    secretHeaders: Object.fromEntries(gates.filter((g) => g.kind === "secret_header").map((g) => [g.name, keys.decrypt(g.secret!, gateContext(orgId, projectId, "secret_header", g.name))])),
  });
}

export async function listProjects(tx: Tx) {
  return tx.selectFrom("projects").select(["id", "name", "target_url", "created_at"]).orderBy("created_at", "desc").execute();
}

export async function projectForEditing(tx: Tx, projectId: string) {
  const project = await tx.selectFrom("projects").select(["id", "name", "target_url", "docs_url", "description", "focus", "allowed_origins"]).where("id", "=", projectId).executeTakeFirst();
  if (!project) return null;
  const [personas, goals, accounts, gates] = await Promise.all([
    tx.selectFrom("personas").select(["key", "name", "brief", "account_ref"]).where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("goals").select(["key", "instruction"]).where("project_id", "=", projectId).orderBy("position").execute(),
    tx.selectFrom("target_accounts").select(["ref", "username", "password_hint"]).where("project_id", "=", projectId).orderBy("ref").execute(),
    tx.selectFrom("target_gates").select(["kind", "name", "value", "secret_hint"]).where("project_id", "=", projectId).orderBy("name").execute(),
  ]);
  return { ...project, personas, goals, accounts, gates };
}

export async function replacePlan(tx: Tx, orgId: string, projectId: string, plan: { personas: Persona[]; goals: Goal[] }): Promise<void> {
  const refs = new Set((await tx.selectFrom("target_accounts").select("ref").where("project_id", "=", projectId).execute()).map((a) => a.ref));
  const project = await tx.selectFrom("projects").select("target_url").where("id", "=", projectId).executeTakeFirst();
  if (!project) throw new Error("project not found");
  const checked = ProjectConfigSchema.safeParse({
    name: "check", targetUrl: project.target_url, personas: plan.personas, goals: plan.goals,
    accounts: [...refs].map((ref) => ({ ref, username: "u", password: "x".repeat(8) })),
  });
  if (!checked.success) throw new Error(checked.error.issues.map((i) => i.message).join("; "));
  await tx.deleteFrom("personas").where("project_id", "=", projectId).execute();
  await tx.deleteFrom("goals").where("project_id", "=", projectId).execute();
  await insertPlan(tx, orgId, projectId, checked.data.personas, checked.data.goals);
  await tx.updateTable("projects").set({ updated_at: new Date() }).where("id", "=", projectId).execute();
}
