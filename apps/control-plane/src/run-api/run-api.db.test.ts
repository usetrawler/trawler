import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, ProjectConfigSchema } from "@usetrawler/protocol";
import { createApiToken } from "../api-tokens/tokens.ts";
import { setModelKey } from "../credentials/credentials.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { handleClaim } from "../runner-api/handlers.ts";
import { FIRST_RUN_ON_US } from "../runs/models.ts";
import { claimJob, HOSTED_SCOPE } from "../runs/queue.ts";
import { cancelLiveRuns, startRun } from "../runs/runs.ts";
import { handleGetRun, handleStartRun, type RunApiDeps } from "./handlers.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const POOL = "pool-token-for-hosted-runners-0000";
let projects: Record<string, string> = {};
let runs: Record<string, string> = {};

const hadARun = async (org: string, projectId: string, providedAccounts?: string[]) => {
  await withOrg(t.db, org, (tx) => startRun(tx, org, projectId, keys, { ...options, ...(providedAccounts ? { providedAccounts, execution: "own" as const } : {}) }));
  await withOrg(t.db, org, (tx) => cancelLiveRuns(tx, org, "stopped"));
};

const runsOf = (projectId: string) => asSystem(t.db, (tx) => tx.selectFrom("runs").select("id").where("project_id", "=", projectId).execute());

const mint = (org: string, projectId?: string) => withOrg(t.db, org, (tx) => createApiToken(tx, org, "u1", { name: "ci", ...(projectId ? { projectId } : {}) }));

beforeAll(async () => {
  for (const org of ["org-a", "org-b", "org-ent", "org-key"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  await sql`insert into workspace_plans (org_id, plan, set_by) values ('org-ent', 'enterprise', 'test') on conflict (org_id) do update set plan = 'enterprise'`.execute(t.db);
  for (const [name, org] of [["hosted", "org-a"], ["own", "org-a"], ["otherOrg", "org-b"], ["ent", "org-ent"]] as const) projects[name] = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
  projects.keyed = await withOrg(t.db, "org-key", (tx) => createProject(tx, "org-key", config, keys));
  await withOrg(t.db, "org-key", (tx) => setModelKey(tx, "org-key", { provider: "openrouter", key: "sk-or-test-key-0123456789abcdef", baseUrl: null }, "u1", keys));
  await hadARun("org-ent", projects.ent!);
  await hadARun("org-key", projects.keyed);
  for (const [name, org, execution] of [["hosted", "org-a", "hosted"], ["own", "org-a", "own"], ["otherOrg", "org-b", "own"]] as const) {
    runs[name] = (await withOrg(t.db, org, (tx) => startRun(tx, org, projects[name]!, keys, { ...options, execution }))).id;
  }
});

describe("claim routing", () => {
  test("a hosted claim never gets an own job, and a token never gets a hosted job or another workspace's job", async () => {
    expect((await claimJob(t.db, keys, { execution: "own", orgId: "org-a", projectId: projects.hosted! }))).toBeNull();
    expect((await claimJob(t.db, keys, { execution: "own", orgId: "org-a", projectId: projects.otherOrg! }))).toBeNull();
    const foreign = await claimJob(t.db, keys, { execution: "own", orgId: "org-b", projectId: null });
    expect(foreign?.runId).toBe(runs.otherOrg);
    const hosted = await claimJob(t.db, keys, HOSTED_SCOPE);
    expect(hosted?.runId).toBe(runs.hosted);
    expect(await claimJob(t.db, keys, HOSTED_SCOPE)).toBeNull();
    const own = await claimJob(t.db, keys, { execution: "own", orgId: "org-a", projectId: null });
    expect(own?.runId).toBe(runs.own);
  });

  test("the claim endpoint takes the pool token for hosted jobs and a workspace token for its own", async () => {
    await asSystem(t.db, (tx) => tx.updateTable("jobs").set({ status: "queued", token_hash: null, lease_until: null }).execute());
    const call = (token: string) => handleClaim(new Request("http://x/claim", { method: "POST", headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } }), { db: t.db, keys, runnerToken: POOL, claimWaitMs: 0 });
    const own = await mint("org-a");
    const viaToken = await call(own.token);
    expect(viaToken.status).toBe(200);
    expect((await viaToken.json()).runId).toBe(runs.own);
    const viaPool = await call(POOL);
    expect((await viaPool.json()).runId).toBe(runs.hosted);
    expect((await call("trw_" + "x".repeat(43))).status).toBe(401);
    expect((await call("some-other-secret-value-0000")).status).toBe(401);
  });
});

describe("run api", () => {
  const deps = (over: Partial<RunApiDeps> = {}): RunApiDeps => ({ db: t.db, keys, baseUrl: "https://app.trawler.test", openRouterUrl: "http://unused.test", trawlerPays: true, priceOf: async () => null, ...over });
  const post = (token: string, body: unknown, over?: Partial<RunApiDeps>) =>
    handleStartRun(new Request("http://x/api/v1/runs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), deps(over));

  test("an enterprise workspace without a model key runs on Trawler's key, many times, without using its first run", async () => {
    const { token } = await mint("org-ent");
    const first = await post(token, { project: projects.ent, execution: "own", cap: 0.5 });
    expect(first.status).toBe(201);
    const started = await first.json();
    expect(started.people).toBeGreaterThan(0);
    expect(started.reportUrl).toMatch(/^https:\/\/app\.trawler\.test\/runs\/\d{4}$/);
    const row = await asSystem(t.db, (tx) => tx.selectFrom("runs").selectAll().where("id", "=", started.id).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ paid_by: "trawler", provider: "openrouter", agent_model: FIRST_RUN_ON_US.model, execution: "own", created_by: expect.stringMatching(/^api-token:/) });
    expect(Number(row.budget_usd)).toBe(0.5);
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
    const second = await post(token, { project: projects.ent });
    expect(second.status).toBe(201);
    const secondId = (await second.json()).id;
    expect(Number((await asSystem(t.db, (tx) => tx.selectFrom("runs").select("budget_usd").where("id", "=", secondId).executeTakeFirstOrThrow())).budget_usd)).toBe(FIRST_RUN_ON_US.budgetUsd);
    expect(await asSystem(t.db, (tx) => tx.selectFrom("first_runs_on_us").select("org_id").where("org_id", "=", "org-ent").execute())).toEqual([]);
    const result = await handleGetRun(new Request("http://x", { headers: { authorization: `Bearer ${token}` } }), started.id, deps());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ id: started.id, finished: true, status: "cancelled", commentMarkdown: expect.stringContaining("<!-- trawler-ci -->") });
  });

  test("accounts from the CI job lift the need for a stored account on an own run, and a hosted run with them is refused", async () => {
    const { token } = await mint("org-ent");
    const id = await withOrg(t.db, "org-ent", (tx) => createProject(tx, "org-ent", { ...config, name: "Signs in" }, keys, { signsIn: ["ana"] }));
    await hadARun("org-ent", id, ["Ana"]);
    const missing = await post(token, { project: id, execution: "own" });
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toBe("Ana needs a test account to sign in.");
    const hosted = await post(token, { project: id, accounts: ["Ana"] });
    expect(hosted.status).toBe(400);
    expect((await hosted.json()).error).toMatch(/accounts can only be given with execution "own"/);
    const started = await post(token, { project: id, execution: "own", accounts: ["Ana"] });
    expect(started.status).toBe(201);
    const { id: runId } = (await started.json()) as { id: string };
    const row = await asSystem(t.db, (tx) => tx.selectFrom("runs").select("provided_accounts").where("id", "=", runId).executeTakeFirstOrThrow());
    expect(row.provided_accounts).toEqual(["Ana"]);
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
  });

  test("a workspace without a key on another plan is told to add one, and a hosted run cannot override the target", async () => {
    const { token } = await mint("org-b");
    const refused = await post(token, { project: projects.otherOrg }, { trawlerPays: false });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toMatch(/Add a model key/);
    const override = await post(token, { project: projects.otherOrg, url: "http://localhost:3000" });
    expect(override.status).toBe(422);
    expect((await post(token, { project: projects.ent })).status).toBe(404);
  });

  test("pull request details and a plan mode are stored with the run, plan by default, and the planner is kicked", async () => {
    const { token } = await mint("org-ent");
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
    let kicked = 0;
    const pullRequest = { number: 482, title: "Add export", description: "Adds a button.", changedFiles: ["src/a.ts"] };
    const started = await (await post(token, { project: projects.ent, pullRequest }, { afterStart: () => void kicked++ })).json();
    expect(kicked).toBe(1);
    const row = await asSystem(t.db, (tx) => tx.selectFrom("runs").select(["pull_request", "pr_plan"]).where("id", "=", started.id).executeTakeFirstOrThrow());
    expect(row.pull_request).toMatchObject(pullRequest);
    expect(row.pr_plan).toEqual({ mode: "both", goalIds: [] });
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
    const regression = await (await post(token, { project: projects.ent, pullRequest, planMode: "regression" })).json();
    expect((await asSystem(t.db, (tx) => tx.selectFrom("runs").select("pr_plan").where("id", "=", regression.id).executeTakeFirstOrThrow())).pr_plan).toBeNull();
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
    expect((await post(token, { project: projects.ent, pullRequest: { description: "x".repeat(4001) } })).status).toBe(400);
    expect((await post(token, { project: projects.ent, planMode: "everything" })).status).toBe(400);
  });

  test("the first run of a project cannot be started from the API, because that is where the person confirms they may test the product", async () => {
    const { token } = await mint("org-ent");
    const fresh = await withOrg(t.db, "org-ent", (tx) => createProject(tx, "org-ent", { ...config, name: "Brand new" }, keys));
    const refused = await post(token, { project: fresh, execution: "own" });
    expect(refused.status).toBe(412);
    expect((await refused.json()).error).toMatch(/Start the first run of this project from the app, where you confirm you are authorised to test it/);
    expect(await runsOf(fresh)).toEqual([]);
    await hadARun("org-ent", fresh);
    expect((await post(token, { project: fresh, execution: "own" })).status).toBe(201);
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
  });

  test("a workspace key is tried on the chosen model before the run is queued, and a refused key or unknown model is a clear refusal", async () => {
    const { token } = await mint("org-key");
    const before = (await runsOf(projects.keyed!)).length;
    const checked: Array<[string, string]> = [];
    const answering = (answer: Awaited<ReturnType<NonNullable<RunApiDeps["modelCheck"]>>>): Partial<RunApiDeps> => ({ modelCheck: async (endpoint, model) => { checked.push([endpoint.key, model]); return answer; } });

    const keyRefused = await post(token, { project: projects.keyed, model: "vendor/model-x" }, answering({ ok: false, reason: "key", detail: "No auth credentials found" }));
    expect(keyRefused.status).toBe(422);
    expect((await keyRefused.json()).error).toBe("OpenRouter did not accept this key (No auth credentials found).");
    const unknownModel = await post(token, { project: projects.keyed, model: "vendor/nope" }, answering({ ok: false, reason: "model", detail: "not a valid model ID" }));
    expect(unknownModel.status).toBe(422);
    expect((await unknownModel.json()).error).toBe("This key cannot use vendor/nope (not a valid model ID). Pick another model.");
    const unreachable = await post(token, { project: projects.keyed, model: "vendor/model-x" }, answering({ ok: false, reason: "unavailable" }));
    expect(unreachable.status).toBe(503);
    expect(checked).toEqual([["sk-or-test-key-0123456789abcdef", "vendor/model-x"], ["sk-or-test-key-0123456789abcdef", "vendor/nope"], ["sk-or-test-key-0123456789abcdef", "vendor/model-x"]]);
    expect(await runsOf(projects.keyed!)).toHaveLength(before);

    const accepted = await post(token, { project: projects.keyed, model: "vendor/model-x" }, answering({ ok: true }));
    expect(accepted.status).toBe(201);
    expect(await runsOf(projects.keyed!)).toHaveLength(before + 1);
    await withOrg(t.db, "org-key", (tx) => cancelLiveRuns(tx, "org-key", "stopped"));
  });

  test("the model check is not made where Trawler pays on its own key, and not for a run that is refused anyway", async () => {
    const never: Partial<RunApiDeps> = { modelCheck: async () => { throw new Error("must not be called"); } };
    const ent = await mint("org-ent");
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
    const onUs = await post(ent.token, { project: projects.ent, execution: "own" }, never);
    expect(onUs.status).toBe(201);
    const inProgress = await post(ent.token, { project: projects.ent, execution: "own" }, never);
    expect(inProgress.status).toBe(409);
    await withOrg(t.db, "org-ent", (tx) => cancelLiveRuns(tx, "org-ent", "stopped"));
    const keyed = await mint("org-key");
    await post(keyed.token, { project: projects.keyed }, { modelCheck: async () => ({ ok: true }) });
    expect((await post(keyed.token, { project: projects.keyed }, never)).status).toBe(409);
    await withOrg(t.db, "org-key", (tx) => cancelLiveRuns(tx, "org-key", "stopped"));
  });
});
