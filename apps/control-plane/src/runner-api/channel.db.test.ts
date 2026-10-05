import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ChannelSchema, PROTOCOL_HEADER, PROTOCOL_VERSION, ProjectConfigSchema } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { claimJob, completeJob, ingestEvents, type JobAssignment } from "../runs/queue.ts";
import { runSummary, startRun } from "../runs/runs.ts";
import { handleChannel, type RunnerApiDeps } from "./handlers.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const deps: RunnerApiDeps = { db: t.db, keys, runnerToken: "runner-token-" + "x".repeat(40) };
const options = { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u" };

const config = (name: string) =>
  ProjectConfigSchema.parse({
    name, targetUrl: "https://app.acme.test/",
    personas: [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b" }],
    goals: [{ id: "g1", instruction: "x", personaId: "ana" }, { id: "g2", instruction: "y", personaId: "lee" }],
  });

beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

async function conversation(name: string) {
  const project = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config(name), keys));
  const run = await withOrg(t.db, "org-a", (tx) => startRun(tx, "org-a", project, keys, { ...options, conversation: true }));
  const ana = (await claimJob(t.db, keys))!;
  const lee = (await claimJob(t.db, keys))!;
  return { run, ana, lee };
}

const say = (job: JobAssignment, seq: number, text: string) => ingestEvents(t.db, job.token, [{ seq, at: new Date().toISOString(), jobId: job.jobId, type: "message", text }], job.jobId);
const read = (job: JobAssignment, token = job.token, query = "") =>
  handleChannel(new Request(`http://cp.test/api/runner/jobs/${job.jobId}/channel${query}`, { headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } }), job.jobId, deps);

test("a person reads only the others' messages, after the cursor, oldest first, with names", async () => {
  const { ana, lee } = await conversation("talking");
  await say(ana, 1, "Anyone seeing the cart empty?");
  await say(lee, 1, "Yes, after I added two items.");
  await say(ana, 2, "Thanks, filing it.");

  const forLee = ChannelSchema.parse(await (await read(lee)).json());
  expect(forLee.messages.map((m) => [m.personaId, m.name, m.text])).toEqual([["ana", "Ana", "Anyone seeing the cart empty?"], ["ana", "Ana", "Thanks, filing it."]]);
  const forAna = ChannelSchema.parse(await (await read(ana)).json());
  expect(forAna.messages.map((m) => m.text)).toEqual(["Yes, after I added two items."]);

  const after = ChannelSchema.parse(await (await read(lee, lee.token, `?after=${forLee.messages[0]!.id}`)).json());
  expect(after.messages.map((m) => m.text)).toEqual(["Thanks, filing it."]);
  expect(after.messages[0]!.id).toBeGreaterThan(forLee.messages[0]!.id);
  expect(ChannelSchema.parse(await (await read(lee, lee.token, `?after=${forLee.messages[1]!.id}`)).json()).messages).toEqual([]);
});

test("the channel refuses another job's token, a bad cursor and an old protocol", async () => {
  const { ana, lee } = await conversation("refusing");
  expect((await read(ana, lee.token)).status).toBe(401);
  expect((await read(ana, "x".repeat(40))).status).toBe(401);
  expect((await read(ana, ana.token, "?after=-1")).status).toBe(400);
  const old = await handleChannel(new Request("http://cp.test/x", { headers: { authorization: `Bearer ${ana.token}`, [PROTOCOL_HEADER]: "0" } }), ana.jobId, deps);
  expect(old.status).toBe(426);
  await completeJob(t.db, ana.token, { usage: { model: "a", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "finish" });
  expect((await read(ana)).status).toBe(401);
});

test("messages of another run never reach a person, and the run page lists the conversation", async () => {
  const first = await conversation("first run");
  await say(first.lee, 1, "private to the first run");
  await sql`update runs set status = 'cancelled', cancel_reason = 'stopped', finished_at = now(), sign_up_seed = null where id = ${first.run.id}`.execute(t.db);
  const second = await conversation("second run");
  await say(second.lee, 1, "hello from the second run");

  expect(ChannelSchema.parse(await (await read(second.ana)).json()).messages.map((m) => m.text)).toEqual(["hello from the second run"]);
  const summary = await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", second.run.id));
  expect(summary).toMatchObject({ conversation: true, conversationMessages: [{ personaKey: "lee", text: "hello from the second run" }] });
});

test("othersWorking is true while another person's session is queued or leased and false once they are done", async () => {
  const { ana, lee } = await conversation("standby");
  expect(ChannelSchema.parse(await (await read(ana)).json()).othersWorking).toBe(true);
  expect(ChannelSchema.parse(await (await read(lee)).json()).othersWorking).toBe(true);
  await completeJob(t.db, lee.token, { usage: { model: "a", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "finish" });
  expect(ChannelSchema.parse(await (await read(ana)).json()).othersWorking).toBe(false);
});

test("a person who went on standby is on standby on the run page until their job completes", async () => {
  const { run, ana, lee } = await conversation("standing by");
  const states = async () => {
    const summary = (await withOrg(t.db, "org-a", (tx) => runSummary(tx, "org-a", run.id)))!;
    return { standing: summary.jobs.filter((j) => j.on_standby).length, latest: summary.activity.map((a) => a.text) };
  };
  expect(await states()).toEqual({ standing: 0, latest: [] });
  await ingestEvents(t.db, ana.token, [{ seq: 1, at: new Date().toISOString(), jobId: ana.jobId, type: "standby" }], ana.jobId);
  expect(await states()).toEqual({ standing: 1, latest: ["Is on standby for the others"] });
  await completeJob(t.db, ana.token, { usage: { model: "a", inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, stoppedBy: "finish" });
  expect((await states()).standing).toBe(0);
  expect(lee.jobId).not.toBe(ana.jobId);
});
