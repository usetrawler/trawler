import { sql } from "kysely";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { setModelKey } from "../credentials/credentials.ts";
import type { Database } from "../db/index.ts";
import { withOrg } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { bearer, sameSecret } from "../runner-api/handlers.ts";
import { isLive } from "../runs/report.ts";
import { cancelRun, runSummary, startRun } from "../runs/runs.ts";

export const SMOKE_ORG = "trawler-smoke";

const SMOKE_RUN = { budgetUsd: 0.1, maxSteps: 12, replaySteps: 8 };
const SMOKE_PROJECT = ProjectConfigSchema.parse({
  name: "Release smoke check",
  targetUrl: "https://demo.playwright.dev/todomvc/",
  description: "A to-do list demo that every release is tried on before it reaches production.",
  personas: [{ id: "smoke", name: "Sam", brief: "You keep a short to-do list and want to add one thing to it quickly." }],
  goals: [{ id: "add-todo", instruction: "A to-do you typed is visible in the list." }],
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SmokeDeps {
  db: Database;
  keys: Keyring;
  smokeToken?: string;
  modelKey?: string;
  model: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function refused(req: Request, deps: SmokeDeps): Response | null {
  if (!deps.smokeToken) return json({ error: "not found" }, 404);
  const token = bearer(req);
  if (!token || !sameSecret(token, deps.smokeToken)) return json({ error: "unknown caller" }, 401);
  return null;
}

export async function handleSmokeStart(req: Request, deps: SmokeDeps): Promise<Response> {
  const refusal = refused(req, deps);
  if (refusal) return refusal;
  const modelKey = deps.modelKey;
  if (!modelKey) return json({ error: "the smoke check needs OPENROUTER_API_KEY on this server" }, 503);
  await deps.db.transaction().execute(async (tx) => {
    await sql`set local role trawler_auth`.execute(tx);
    await tx.insertInto("organization").values({ id: SMOKE_ORG, name: "Release smoke check", slug: SMOKE_ORG, createdAt: new Date() }).onConflict((oc) => oc.column("id").doNothing()).execute();
  });
  const runId = await withOrg(deps.db, SMOKE_ORG, async (tx) => {
    const leftOver = await tx.selectFrom("runs").select("id").where("org_id", "=", SMOKE_ORG).where("status", "in", ["queued", "running"]).execute();
    for (const run of leftOver) await cancelRun(tx, SMOKE_ORG, run.id);
    await setModelKey(tx, SMOKE_ORG, { provider: "openrouter", key: modelKey }, "smoke", deps.keys);
    const projectId = await createProject(tx, SMOKE_ORG, SMOKE_PROJECT, deps.keys);
    const run = await startRun(tx, SMOKE_ORG, projectId, deps.keys, { ...SMOKE_RUN, agentModel: deps.model, judgeModel: deps.model, createdBy: "smoke", provider: "openrouter" });
    return run.id;
  });
  return json({ runId }, 201);
}

export async function handleSmokeStatus(req: Request, runId: string, deps: SmokeDeps): Promise<Response> {
  const refusal = refused(req, deps);
  if (refusal) return refusal;
  if (!UUID.test(runId)) return json({ error: "not found" }, 404);
  const summary = await withOrg(deps.db, SMOKE_ORG, (tx) => runSummary(tx, SMOKE_ORG, runId));
  if (!summary) return json({ error: "not found" }, 404);
  return json({
    runId,
    status: summary.status,
    finished: !isLive(summary.status),
    costUsd: summary.costUsd,
    goalsReached: summary.goals.filter((g) => g.status === "reached").length,
    goalsTotal: summary.personas.length * summary.goalTexts.length,
    jobs: summary.jobs.map((j) => ({ kind: j.kind, status: j.status, stoppedBy: j.stopped_by, error: j.error })),
  });
}
