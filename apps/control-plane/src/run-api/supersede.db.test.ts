import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { createApiToken } from "../api-tokens/tokens.ts";
import { setModelKey } from "../credentials/credentials.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { cancelLiveRuns, MAX_LIVE_OWN_RUNS, startRun } from "../runs/runs.ts";
import { handleGetRun, handleStartRun, type RunApiDeps } from "./handlers.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
const options = { budgetUsd: 2, agentModel: "m/agent", judgeModel: "m/judge", maxSteps: 30, replaySteps: 20, createdBy: "u1" };
const ORG = "org-api";
const KEYLESS = "org-keyless";
let project = "";
let keyless = "";
let token = "";

const deps = (over: Partial<RunApiDeps> = {}): RunApiDeps => ({ db: t.db, keys, baseUrl: "https://app.trawler.test", openRouterUrl: "http://unused.test", trawlerPays: false, priceOf: async () => null, modelCheck: async () => ({ ok: true }), ...over });
const post = (body: unknown, over?: Partial<RunApiDeps>, as = token) =>
  handleStartRun(new Request("http://x/api/v1/runs", { method: "POST", headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: JSON.stringify(body) }), deps(over));
const ci = (number: number, over: Record<string, unknown> = {}) => post({ project, execution: "own", url: "http://localhost:3000", pullRequest: { number, repository: "acme/shop" }, ...over });
const get = (id: string) => handleGetRun(new Request(`http://x/api/v1/runs/${id}`, { headers: { authorization: `Bearer ${token}` } }), id, deps());

beforeAll(async () => {
  for (const org of [ORG, KEYLESS]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  await withOrg(t.db, ORG, (tx) => setModelKey(tx, ORG, { provider: "openrouter", key: "sk-or-test-key-0123456789abcdef", baseUrl: null }, "u1", keys));
  project = await withOrg(t.db, ORG, (tx) => createProject(tx, ORG, config, keys));
  keyless = await withOrg(t.db, KEYLESS, (tx) => createProject(tx, KEYLESS, config, keys));
  for (const [org, id] of [[ORG, project], [KEYLESS, keyless]] as const) {
    await withOrg(t.db, org, (tx) => startRun(tx, org, id, keys, options));
    await withOrg(t.db, org, (tx) => cancelLiveRuns(tx, org, "stopped"));
  }
  token = (await withOrg(t.db, ORG, (tx) => createApiToken(tx, ORG, "u1", { name: "ci" }))).token;
});

afterEach(async () => {
  await withOrg(t.db, ORG, (tx) => cancelLiveRuns(tx, ORG, "stopped"));
});

const cancelReason = async (id: string) => (await asSystem(t.db, (tx) => tx.selectFrom("runs").select(["status", "cancel_reason"]).where("id", "=", id).executeTakeFirstOrThrow()));

describe("starting runs for pull requests through the API", () => {
  test("a second start for the same pull request answers 201 and stops the first one as superseded, which its poll then reports", async () => {
    const first = await ci(21);
    expect(first.status).toBe(201);
    const firstId = (await first.json()).id as string;
    const second = await ci(21);
    expect(second.status).toBe(201);
    expect(await cancelReason(firstId)).toEqual({ status: "cancelled", cancel_reason: "superseded" });
    const polled = await (await get(firstId)).json();
    expect(polled).toMatchObject({ status: "cancelled", finished: true, cancelReason: "superseded" });
    expect(polled.commentMarkdown).toContain("a newer push started another");
    expect(polled.commentMarkdown).not.toContain("could not finish");
  });

  test("runs for different pull requests go in parallel, and a hosted run still refuses a hosted run with 409", async () => {
    expect((await ci(1)).status).toBe(201);
    expect((await ci(2)).status).toBe(201);
    const hosted = await post({ project });
    expect(hosted.status).toBe(201);
    const refused = await post({ project });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/is still going on this project/);
    expect((await ci(3)).status).toBe(201);
    const onTarget = await post({ project, execution: "own" });
    expect(onTarget.status).toBe(409);
  });

  test(`answers 429 beyond ${MAX_LIVE_OWN_RUNS} runs in CI jobs and says why, but still takes a push to a pull request that is already running`, async () => {
    for (let n = 1; n <= MAX_LIVE_OWN_RUNS; n++) expect((await ci(n)).status).toBe(201);
    const over = await ci(99);
    expect(over.status).toBe(429);
    expect((await over.json()).error).toContain(`${MAX_LIVE_OWN_RUNS} runs going in CI jobs`);
    expect((await ci(2)).status).toBe(201);
    expect((await post({ project })).status).toBe(201);
  });

  test("marks refusals about the model key so a CI client can tell them from a problem with the pull request", async () => {
    const refusedKey = await post({ project }, { modelCheck: async () => ({ ok: false, reason: "key", detail: "No auth credentials found" }) });
    expect(refusedKey.status).toBe(422);
    expect(await refusedKey.json()).toEqual({ error: "OpenRouter did not accept this key (No auth credentials found).", code: "model_key" });
    const unreachable = await post({ project }, { modelCheck: async () => ({ ok: false, reason: "unavailable" }) });
    expect(unreachable.status).toBe(503);
    expect((await unreachable.json()).code).toBe("model_key");
    const keylessToken = (await withOrg(t.db, KEYLESS, (tx) => createApiToken(tx, KEYLESS, "u1", { name: "ci" }))).token;
    const noKey = await post({ project: keyless }, undefined, keylessToken);
    expect(noKey.status).toBe(422);
    expect(await noKey.json()).toEqual({ error: "Add a model key in Settings to start runs.", code: "model_key" });
    const paused = await asSystem(t.db, (tx) => tx.updateTable("projects").set({ paused_at: new Date(), paused_by: "u1" }).where("id", "=", project).execute());
    expect(paused).toBeDefined();
    const pausedAnswer = await post({ project });
    expect(pausedAnswer.status).toBe(422);
    expect((await pausedAnswer.json()).code).toBeUndefined();
    await asSystem(t.db, (tx) => tx.updateTable("projects").set({ paused_at: null, paused_by: null }).where("id", "=", project).execute());
  });
});
