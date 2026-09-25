import { randomBytes } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS_PER_JOB, PROTOCOL_HEADER, PROTOCOL_VERSION, ProjectConfigSchema } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { handleArtifactUpload, type RunnerApiDeps } from "../runner-api/handlers.ts";
import { claimJob, completeJob, ingestEvents, type JobAssignment } from "../runs/queue.ts";
import { startRun } from "../runs/runs.ts";
import { artifactLink } from "./artifacts.ts";
import { removeExpiredArtifacts } from "./cleanup.ts";
import { s3Store, type ArtifactStore } from "./store.ts";
import { testStorage } from "./test-storage.ts";

const t = await testDb();
const storage = await testStorage();
const store = s3Store(storage);
const s3 = new S3Client({ region: storage.region, endpoint: storage.endpoint, forcePathStyle: true, credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
afterAll(async () => {
  s3.destroy();
  await t.drop();
});
const keys = new Keyring(randomBytes(32));
const deps: RunnerApiDeps = { db: t.db, keys, runnerToken: "runner-token-" + "x".repeat(40), artifacts: store };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), randomBytes(64)]);

const config = ProjectConfigSchema.parse({
  name: "Acme", targetUrl: "https://app.acme.test/",
  personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Save an invoice." }],
});

beforeAll(async () => {
  for (const org of ["org-a", "org-b"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
});

async function leasedJob(org = "org-a"): Promise<JobAssignment> {
  const project = await withOrg(t.db, org, (tx) => createProject(tx, org, config, keys));
  await withOrg(t.db, org, (tx) => startRun(tx, org, project, keys, { budgetUsd: 1, agentModel: "a", judgeModel: "j", maxSteps: 5, replaySteps: 5, createdBy: "u" }));
  const job = await claimJob(t.db, keys);
  if (!job) throw new Error("no job to claim");
  return job;
}

function upload(job: { jobId: string; token?: string }, bytes: Uint8Array | ReadableStream<Uint8Array>, options: { type?: string; query?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "content-type": options.type ?? "image/png", [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...(job.token ? { authorization: `Bearer ${job.token}` } : {}), ...options.headers };
  return new Request(`http://cp.test/api/jobs/${job.jobId}/artifacts?${options.query ?? "kind=screenshot"}`, { method: "POST", headers, body: bytes, duplex: "half" } as RequestInit);
}

async function objectKeys(): Promise<string[]> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: storage.bucket }));
  return (listed.Contents ?? []).map((o) => o.Key!).sort();
}

async function storedObject(key: string): Promise<{ bytes: Buffer; type: string | undefined }> {
  const got = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  return { bytes: Buffer.from(await got.Body!.transformToByteArray()), type: got.ContentType };
}

test("a job stores a screenshot with its own token: the file under the workspace and run, and a row that links it to the finding", async () => {
  const job = await leasedJob();
  const res = await handleArtifactUpload(upload(job, PNG, { query: "kind=screenshot&finding=f1" }), job.jobId, deps);
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const row = await withOrg(t.db, "org-a", (tx) => tx.selectFrom("artifacts").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
  expect(row).toMatchObject({ org_id: "org-a", run_id: job.runId, job_id: job.jobId, finding_key: "ana:f1", kind: "screenshot", content_type: "image/png", size_bytes: PNG.byteLength, storage_key: `orgs/org-a/runs/${job.runId}/${id}.png` });
  expect(await storedObject(row.storage_key)).toEqual({ bytes: PNG, type: "image/png" });

  for (const [bytes, type, extension] of [[JPEG, "image/jpeg", "jpg"], [WEBP, "image/webp", "webp"]] as const) {
    const other = await handleArtifactUpload(upload(job, bytes, { type }), job.jobId, deps);
    expect(other.status).toBe(201);
    const stored = await withOrg(t.db, "org-a", async (tx) => tx.selectFrom("artifacts").selectAll().where("id", "=", (await other.json()).id).executeTakeFirstOrThrow());
    expect(stored).toMatchObject({ finding_key: null, content_type: type, storage_key: expect.stringMatching(new RegExp(`\\.${extension}$`)) });
    expect((await storedObject(stored.storage_key)).bytes).toEqual(bytes);
  }
});

test("a replay's screenshot belongs to the finding it replays, whatever the upload names", async () => {
  const session = await leasedJob();
  const at = new Date().toISOString();
  const finding = { id: "f1", kind: "defect", goal: "g", title: "Saving fails", observed: "An error page", reproduction: ["Open the form", "Click Save"], severity: "high" };
  await ingestEvents(t.db, session.token, [{ seq: 1, at, jobId: session.jobId, type: "finding", finding }] as never, session.jobId);
  await completeJob(t.db, session.token, { usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0, steps: 1 }, stoppedBy: "finish" }, session.jobId);
  const replay = await claimJob(t.db, keys);
  expect(replay).toMatchObject({ kind: "replay", runId: session.runId });
  const res = await handleArtifactUpload(upload(replay!, PNG, { query: "kind=screenshot&finding=f9" }), replay!.jobId, deps);
  expect(res.status).toBe(201);
  const row = await withOrg(t.db, "org-a", async (tx) => tx.selectFrom("artifacts").select("finding_key").where("id", "=", (await res.json()).id).executeTakeFirstOrThrow());
  expect(row.finding_key).toBe("ana:f1");
});

test("an upload is refused, leaving no file and no row, without the job's own live token, with a wrong type or signature, or when too large", async () => {
  const job = await leasedJob();
  const other = await leasedJob();
  const before = await objectKeys();
  const count = async () => Number((await sql<{ n: string }>`select count(*) as n from artifacts where job_id = ${job.jobId}`.execute(t.db)).rows[0]!.n);
  const refused: Array<[Request, number]> = [
    [upload(job, PNG, { headers: { [PROTOCOL_HEADER]: "0" } }), 426],
    [upload({ jobId: job.jobId }, PNG), 401],
    [upload({ jobId: job.jobId, token: other.token }, PNG), 401],
    [upload(job, Buffer.from("<html><script>alert(1)</script></html>"), { type: "text/html" }), 415],
    [upload(job, JPEG, { type: "image/png" }), 415],
    [upload(job, PNG, { query: "kind=video" }), 400],
    [upload(job, PNG, { query: "kind=screenshot&finding=" + "f".repeat(101) }), 400],
    [upload(job, PNG, { headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) } }), 413],
  ];
  for (const [request, status] of refused) expect((await handleArtifactUpload(request, job.jobId, deps)).status, `${request.url} → ${status}`).toBe(status);

  const endless = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(PNG);
      for (let sent = 0; sent <= MAX_ARTIFACT_BYTES; sent += 1024 * 1024) controller.enqueue(new Uint8Array(1024 * 1024));
      controller.close();
    },
  });
  expect((await handleArtifactUpload(upload(job, endless), job.jobId, deps)).status).toBe(413);
  expect(await objectKeys()).toEqual(before);
  expect(await count()).toBe(0);
});

test("a job that is over, or whose lease ran out, can no longer store files, and a job stores at most its share", async () => {
  const finished = await leasedJob();
  await completeJob(t.db, finished.token, { usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0, steps: 1 }, stoppedBy: "finish" }, finished.jobId);
  expect((await handleArtifactUpload(upload(finished, PNG), finished.jobId, deps)).status).toBe(409);

  const expired = await leasedJob();
  await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${expired.jobId}`.execute(t.db);
  expect((await handleArtifactUpload(upload(expired, PNG), expired.jobId, deps)).status).toBe(401);

  const busy = await leasedJob();
  for (let i = 0; i < MAX_ARTIFACTS_PER_JOB; i++) {
    await sql`insert into artifacts (org_id, run_id, job_id, kind, content_type, size_bytes, storage_key) values ('org-a', ${busy.runId}, ${busy.jobId}, 'screenshot', 'image/png', 10, ${`orgs/org-a/runs/${busy.runId}/filler-${i}.png`})`.execute(t.db);
  }
  const res = await handleArtifactUpload(upload(busy, PNG), busy.jobId, deps);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/at most 50/);
});

test("without storage configured, uploads answer 503", async () => {
  const job = await leasedJob();
  expect((await handleArtifactUpload(upload(job, PNG), job.jobId, { ...deps, artifacts: undefined })).status).toBe(503);
});

test("a short-lived link serves the file with its type, and only to the workspace that owns it", async () => {
  const job = await leasedJob();
  const { id } = await (await handleArtifactUpload(upload(job, PNG), job.jobId, deps)).json();
  const link = await artifactLink(t.db, store, "org-a", id);
  expect(link).toMatch(/X-Amz-Expires=300/);
  const res = await fetch(link!);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  expect(await artifactLink(t.db, store, "org-b", id)).toBeNull();
  expect(await artifactLink(t.db, store, "org-a", "00000000-0000-4000-8000-000000000000")).toBeNull();
  expect(await artifactLink(t.db, store, "org-a", "not-a-uuid")).toBeNull();
});

test("files older than 30 days are removed with their rows; newer ones stay", async () => {
  const job = await leasedJob("org-b");
  const stored: string[] = [];
  for (let i = 0; i < 3; i++) stored.push((await (await handleArtifactUpload(upload(job, PNG), job.jobId, deps)).json()).id);
  const [old, older, fresh] = stored as [string, string, string];
  await sql`update artifacts set created_at = now() - interval '31 days' where id in (${old}, ${older})`.execute(t.db);
  await sql`update artifacts set created_at = now() - interval '29 days' where id = ${fresh}`.execute(t.db);
  const keyOf = async (id: string) => (await sql<{ storage_key: string }>`select storage_key from artifacts where id = ${id}`.execute(t.db)).rows[0]!.storage_key;
  const [oldKey, olderKey, freshKey] = [await keyOf(old), await keyOf(older), await keyOf(fresh)];

  expect(await removeExpiredArtifacts(t.db, store, { batch: 1 })).toBe(2);
  const left = await sql<{ id: string }>`select id from artifacts where job_id = ${job.jobId}`.execute(t.db);
  expect(left.rows.map((r) => r.id)).toEqual([fresh]);
  const keys = await objectKeys();
  expect(keys).toContain(freshKey);
  expect(keys).not.toContain(oldKey);
  expect(keys).not.toContain(olderKey);
  expect(await removeExpiredArtifacts(t.db, store)).toBe(0);
});

test("a file the bucket fails to delete keeps its row for the next cleanup, and two cleanups at once remove each file once", async () => {
  const job = await leasedJob("org-b");
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await (await handleArtifactUpload(upload(job, PNG), job.jobId, deps)).json()).id);
  await sql`update artifacts set created_at = now() - interval '40 days' where job_id = ${job.jobId}`.execute(t.db);
  const stuckKey = (await sql<{ storage_key: string }>`select storage_key from artifacts where id = ${ids[0]!}`.execute(t.db)).rows[0]!.storage_key;
  const removed: string[] = [];
  const flaky: ArtifactStore = {
    ...store,
    remove: async (key) => {
      if (key === stuckKey) throw new Error("the bucket is unavailable");
      removed.push(key);
      await store.remove(key);
    },
  };
  const [a, b] = await Promise.all([removeExpiredArtifacts(t.db, flaky, { batch: 2 }), removeExpiredArtifacts(t.db, flaky, { batch: 2 })]);
  expect(a + b).toBe(3);
  expect(new Set(removed).size).toBe(removed.length);
  const left = await sql<{ id: string }>`select id from artifacts where job_id = ${job.jobId}`.execute(t.db);
  expect(left.rows.map((r) => r.id)).toEqual([ids[0]]);
  expect(await objectKeys()).toContain(stuckKey);
  expect(await removeExpiredArtifacts(t.db, flaky, { batch: 1 })).toBe(0);
  expect(await removeExpiredArtifacts(t.db, store)).toBe(1);
});
