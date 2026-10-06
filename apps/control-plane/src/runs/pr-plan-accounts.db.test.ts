import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { scriptedModel, text } from "../../../../packages/core/src/testing.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { planDueRuns } from "./pr-plan.ts";
import { claimJob, completeJob } from "./queue.ts";
import { runSummary, startRun } from "./runs.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const options = { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u", execution: "own" as const, providedAccounts: ["Ana", "Priya"] };
const scopeOf = (projectId: string) => ({ execution: "own", orgId: "org-a", projectId }) as const;
const done = { usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0.01, steps: 1 }, stoppedBy: "finish" as const };
const pullRequest = { number: 77, title: "Let admins invite colleagues", description: "Admins send an invitation link.", changedFiles: ["src/server/invitations.ts"] };

const config = ProjectConfigSchema.parse({
  name: "Team", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "priya", name: "Priya", brief: "b" }],
  goals: [{ id: "g1", instruction: "Look around the team page", personaId: "ana" }, { id: "g2", instruction: "Look around the home page", personaId: "priya" }],
  accounts: [],
});

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

const answer = (flow: Record<string, unknown>) => text(JSON.stringify({ turns: [{ person: "priya", goals: [{ id: "joins", instruction: "A new colleague joins the team and sees its workspace" }] }], ...flow }));
const lead = (model: ReturnType<typeof scriptedModel> | null) => ({ db: t.db, model, modelId: "setup-model" });
const newProject = (name: string) => withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", { ...config, name }, keys, { signsIn: ["ana"] }));
const startOn = (project: string, over: Partial<Parameters<typeof startRun>[4]> = {}) => withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, pullRequest, ...over }));
const provided = async (runId: string) => (await sql<{ provided_accounts: string[] }>`select provided_accounts from runs where id = ${runId}`.execute(t.db)).rows[0]!.provided_accounts;
const summary = (runId: string) => withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", runId));
const leadOutput = async (project: string) => (await sql<{ accountFlow: string; accountReason: string | null }>`select account_flow as "accountFlow", account_reason as "accountReason" from plans where project_id = ${project} and kind = 'pull_request'`.execute(t.db)).rows;

async function finish(runId: string) {
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${runId}`.execute(t.db);
  await sql`update jobs set status = 'cancelled' where run_id = ${runId} and status in ('queued', 'leased')`.execute(t.db);
}

async function claimTurn(project: string, personaKey: string) {
  const scope = scopeOf(project);
  let job = (await claimJob(t.db, keys, scope))!;
  while (job.kind !== "role_session" || job.personaKey !== personaKey) {
    await completeJob(t.db, job.token, { ...done, ...(job.kind === "account_check" ? { stoppedBy: "report" as const, signIn: { outcome: "signed_in" as const, observed: "ok" } } : {}) });
    job = (await claimJob(t.db, keys, scope))!;
  }
  return job;
}

test("exercise: only the people who sign in keep the CI account, and the change is made before any turn can be claimed", async () => {
  const project = await newProject("exercise");
  const run = await startOn(project);
  expect(await provided(run.id)).toEqual(["Ana", "Priya"]);
  expect(await claimJob(t.db, keys, scopeOf(project))).toBeNull();
  expect(await planDueRuns(lead(scriptedModel([answer({ accountFlow: "exercise", accountReason: "Changes how invited colleagues join a team." })])))).toBe(1);
  expect(await provided(run.id)).toEqual(["Ana"]);
  const seen = (await summary(run.id))!;
  expect(seen.providedAccounts).toEqual(["Ana"]);
  expect(seen.prPlan).toMatchObject({ signUps: ["Priya"], accountReason: "Changes how invited colleagues join a team." });
  expect((await claimTurn(project, "priya")).providedAccounts).toEqual(["Ana"]);
  expect(await leadOutput(project)).toEqual([{ accountFlow: "exercise", accountReason: "Changes how invited colleagues join a team." }]);
  await finish(run.id);
});

test("provided: the people named by the CI job keep their accounts, signing in or signing up", async () => {
  const project = await newProject("provided");
  const run = await startOn(project);
  await planDueRuns(lead(scriptedModel([answer({ accountFlow: "provided", accountReason: "Only the team page changes." })])));
  expect(await provided(run.id)).toEqual(["Ana", "Priya"]);
  expect((await summary(run.id))!.prPlan).toMatchObject({ goals: [expect.anything()] });
  expect((await summary(run.id))!.prPlan).not.toHaveProperty("signUps");
  expect((await claimTurn(project, "priya")).providedAccounts).toEqual(["Ana", "Priya"]);
  expect(await leadOutput(project)).toEqual([expect.objectContaining({ accountFlow: "provided" })]);
  await finish(run.id);
});

test("a lead that gives no valid flow leaves the provided accounts as they are", async () => {
  const project = await newProject("invalid");
  const run = await startOn(project);
  await planDueRuns(lead(scriptedModel([answer({ accountFlow: "sometimes" })])));
  expect(await provided(run.id)).toEqual(["Ana", "Priya"]);
  await finish(run.id);
});

test("a reused stored plan applies its flow with no lead call", async () => {
  const project = await newProject("reuse");
  const first = await startOn(project);
  await planDueRuns(lead(scriptedModel([answer({ accountFlow: "exercise", accountReason: "Changes how invited colleagues join a team." })])));
  await finish(first.id);

  const second = await startOn(project);
  expect((await sql`select 1 from jobs where run_id = ${second.id} and kind = 'pr_plan'`.execute(t.db)).rows).toHaveLength(0);
  expect(await planDueRuns(lead(null))).toBe(0);
  expect(await provided(second.id)).toEqual(["Ana"]);
  expect((await summary(second.id))!.prPlan).toMatchObject({ reused: true, signUps: ["Priya"], accountReason: "Changes how invited colleagues join a team." });
  expect((await claimTurn(project, "priya")).providedAccounts).toEqual(["Ana"]);
  await finish(second.id);
});

test("replan asks the lead again and takes its new flow", async () => {
  const project = await newProject("replan");
  const first = await startOn(project);
  await planDueRuns(lead(scriptedModel([answer({ accountFlow: "exercise" })])));
  await finish(first.id);
  const again = await startOn(project, { replan: true });
  expect(await provided(again.id)).toEqual(["Ana", "Priya"]);
  await planDueRuns(lead(scriptedModel([answer({ accountFlow: "provided" })])));
  expect(await provided(again.id)).toEqual(["Ana", "Priya"]);
  expect(await leadOutput(project)).toEqual([expect.objectContaining({ accountFlow: "provided" })]);
  await finish(again.id);
});

test("a person who is not named by the CI job is left alone, and a failed lead changes nothing", async () => {
  const project = await newProject("none");
  const own = await startOn(project, { providedAccounts: ["Ana"] });
  await planDueRuns(lead(scriptedModel([answer({ accountFlow: "exercise" })])));
  expect(await provided(own.id)).toEqual(["Ana"]);
  await finish(own.id);
  const failing = await startOn(project, { pullRequest: { ...pullRequest, number: 78 } });
  await planDueRuns(lead(scriptedModel([new Error("provider is down"), new Error("provider is down")])));
  expect(await provided(failing.id)).toEqual(["Ana", "Priya"]);
  expect((await summary(failing.id))!.prPlan).not.toHaveProperty("accountFlow");
  await finish(failing.id);
});
