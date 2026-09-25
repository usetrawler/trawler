import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { scriptedModel, text, toolCall } from "../../../../packages/core/src/testing.ts";
import { workOnce } from "../../../runner/src/worker.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { runSummary, startRun } from "../runs/runs.ts";
import { handleClaim, handleComplete, handleEvents, type RunnerApiDeps } from "./handlers.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const runnerToken = "runner-" + "r".repeat(40);
const deps: RunnerApiDeps = { db: t.db, keys, runnerToken, claimWaitMs: 50, pollMs: 10 };
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://cp.test${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const match = /^\/api\/jobs\/([^/]+)\/(events|complete)$/.exec(req.url ?? "");
    const response = req.url === "/api/runner/claim" ? await handleClaim(request, deps) : match ? await (match[2] === "events" ? handleEvents : handleComplete)(request, match[1]!, deps) : new Response(null, { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("a run goes from start to a confirmed defect through the real runner API and worker", async () => {
  const config = ProjectConfigSchema.parse({
    name: "Acme", targetUrl: "https://app.acme.test/",
    personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Save an invoice." }],
  });
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { budgetUsd: 1, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 10, replaySteps: 10, createdBy: "u" }));
  const scripts: Record<string, ReturnType<typeof scriptedModel>> = {
    role: scriptedModel([
      toolCall("submit_finding", { kind: "defect", goal: "g", title: "Saving fails", observed: "Save returned an error page", reproduction: ["Open https://app.acme.test/invoices/new", "Click Save"], severity: "high" }),
      toolCall("goal_status", { goal: "g", status: "failed", note: "error page" }),
      toolCall("finish", { summary: "done" }),
    ]),
    replay: scriptedModel([toolCall("report_replay", { completed: true, observed: "An Internal Server Error page appeared", blockedAt: null })]),
    judge: scriptedModel([text(JSON.stringify({ verdict: "confirmed" }))]),
  };
  const order = ["role", "replay", "judge"];
  let current = 0;
  const worker = {
    controlPlane: base, runnerToken, log: () => {}, flushMs: 5, retryBaseMs: 5,
    model: () => scripts[order[current]!]!,
    openBrowser: async () => ({ tools: {}, fillField: async () => "typed", close: async () => {} }),
  };
  for (; current < order.length; current++) expect(await workOnce(worker)).toBe("done");
  expect(await workOnce(worker)).toBe("idle");
  const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id));
  expect(summary).toMatchObject({ status: "succeeded" });
  expect(summary!.findings).toEqual([expect.objectContaining({ key: "ana:f1", title: "Saving fails", verdict: "confirmed", replay: expect.objectContaining({ completed: true }) })]);
  expect(summary!.goals).toEqual([{ personaKey: "ana", goal: "g", status: "failed", note: "error page" }]);
  expect(summary!.costUsd).toBeCloseTo(0.005, 6);
});
