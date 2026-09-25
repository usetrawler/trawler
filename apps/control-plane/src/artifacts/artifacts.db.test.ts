import { randomBytes } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { ArtifactStoredSchema, MAX_ARTIFACT_BYTES, MAX_ARTIFACTS_PER_JOB, PROTOCOL_HEADER, PROTOCOL_VERSION, ProjectConfigSchema } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { handleArtifactUpload, type RunnerApiDeps } from "../runner-api/handlers.ts";
import { claimJob, completeJob, ingestEvents, releaseJobForShutdown, type JobAssignment } from "../runs/queue.ts";
import { cancelRun, startRun } from "../runs/runs.ts";
import { artifactLink } from "./artifacts.ts";
import { MAX_FAILURES_PER_RUN, removeExpiredArtifacts } from "./cleanup.ts";
import { s3Store, type ArtifactStore } from "./store.ts";
import { testStorage } from "./test-storage.ts";

const t = await testDb();
const { storage, client: s3, drop } = await testStorage();
const store = s3Store(storage);
afterAll(async () => {
  await drop();
  await t.drop();
});
afterEach(() => vi.restoreAllMocks());
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

async function stored(job: { jobId: string; token?: string }, bytes: Uint8Array = PNG, options: { type?: string; query?: string } = {}): Promise<string> {
  const res = await handleArtifactUpload(upload(job, bytes, options), job.jobId, deps);
  expect(res.status).toBe(201);
  return ArtifactStoredSchema.parse(await res.json()).id;
}

async function objectKeys(): Promise<string[]> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: storage.bucket }));
  return (listed.Contents ?? []).map((o) => o.Key!).sort();
}

async function storedObject(key: string): Promise<{ bytes: Buffer; type: string | undefined }> {
  const got = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  return { bytes: Buffer.from(await got.Body!.transformToByteArray()), type: got.ContentType };
}

const rowOf = (id: string) => withOrg(t.db, "org-a", (tx) => tx.selectFrom("artifacts").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
const rowsOf = async (jobId: string) => Number((await sql<{ n: string }>`select count(*) as n from artifacts where job_id = ${jobId}`.execute(t.db)).rows[0]!.n);

function counted(total: number): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(PNG);
      else if (pulls <= total) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulls, cancelled: () => cancelled };
}

const done = (job: JobAssignment) => completeJob(t.db, job.token, { usage: { model: "a", inputTokens: 1, outputTokens: 1, costUsd: 0, steps: 1 }, stoppedBy: "finish" }, job.jobId);

async function fill(job: JobAssignment, org: string, count: number, age = "0 days") {
  await sql`insert into artifacts (org_id, run_id, job_id, kind, content_type, size_bytes, storage_key, created_at)
    select ${org}, ${job.runId}::uuid, ${job.jobId}::uuid, 'screenshot', 'image/png', 10, ${`orgs/${org}/runs/${job.runId}/filler-`} || gen_random_uuid() || '.png', now() - ${age}::interval
    from generate_series(1, ${count})`.execute(t.db);
}

test("a job stores a screenshot with its own token: the file under the workspace and run, and a row that links it to the finding", async () => {
  const job = await leasedJob();
  const id = await stored(job, PNG, { query: "kind=screenshot&finding=f1" });
  const row = await rowOf(id);
  expect(row).toMatchObject({ org_id: "org-a", run_id: job.runId, job_id: job.jobId, finding_key: "ana:f1", kind: "screenshot", content_type: "image/png", size_bytes: PNG.byteLength, storage_key: `orgs/org-a/runs/${job.runId}/${id}.png`, discarded_at: null });
  expect(await storedObject(row.storage_key)).toEqual({ bytes: PNG, type: "image/png" });

  for (const [bytes, type, extension] of [[JPEG, "image/jpeg", "jpg"], [WEBP, "image/webp", "webp"]] as const) {
    const other = await rowOf(await stored(job, bytes, { type }));
    expect(other).toMatchObject({ finding_key: null, content_type: type, storage_key: expect.stringMatching(new RegExp(`\\.${extension}$`)) });
    expect((await storedObject(other.storage_key)).bytes).toEqual(bytes);
  }
});

test("a finding name is kept the way ingested findings keep it, so a NUL byte never breaks the upload or leaves a file behind", async () => {
  const job = await leasedJob();
  const before = await objectKeys();
  const row = await rowOf(await stored(job, PNG, { query: "kind=screenshot&finding=f%001" }));
  expect(row.finding_key).toBe("ana:f1");
  expect(await objectKeys()).toEqual([...before, row.storage_key].sort());
});

test("a replay's screenshot belongs to the finding it replays, whatever the upload names", async () => {
  const session = await leasedJob();
  const at = new Date().toISOString();
  const finding = { id: "f1", kind: "defect", goal: "g", title: "Saving fails", observed: "An error page", reproduction: ["Open the form", "Click Save"], severity: "high" };
  await ingestEvents(t.db, session.token, [{ seq: 1, at, jobId: session.jobId, type: "finding", finding }] as never, session.jobId);
  await done(session);
  const replay = await claimJob(t.db, keys);
  expect(replay).toMatchObject({ kind: "replay", runId: session.runId });
  expect((await rowOf(await stored(replay!, PNG, { query: "kind=screenshot&finding=f9" }))).finding_key).toBe("ana:f1");
});

test("an upload is refused, leaving no file and no row, without the job's own live token, with a wrong type or signature, or when too large", async () => {
  const job = await leasedJob();
  const other = await leasedJob();
  const before = await objectKeys();
  const refused: Array<[Request, number]> = [
    [upload(job, PNG, { headers: { [PROTOCOL_HEADER]: "0" } }), 426],
    [upload({ jobId: job.jobId }, PNG), 401],
    [upload({ jobId: job.jobId, token: other.token }, PNG), 401],
    [upload(job, Buffer.from("<html><script>alert(1)</script></html>"), { type: "text/html" }), 415],
    [upload(job, PNG, { type: "constructor" }), 415],
    [upload(job, JPEG, { type: "image/png" }), 415],
    [upload(job, PNG, { query: "kind=video" }), 400],
    [upload(job, PNG, { query: "kind=screenshot&finding=" + "f".repeat(101) }), 400],
    [upload(job, PNG, { headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) } }), 413],
  ];
  for (const [request, status] of refused) expect((await handleArtifactUpload(request, job.jobId, deps)).status, `${request.url} → ${status}`).toBe(status);

  const endless = counted(64);
  expect((await handleArtifactUpload(upload(job, endless.stream), job.jobId, deps)).status).toBe(413);
  expect(endless.pulled()).toBeLessThan(8);
  expect(endless.cancelled()).toBe(true);
  expect(await objectKeys()).toEqual(before);
  expect(await rowsOf(job.jobId)).toBe(0);
});

test("a request that may not store a file is answered before its body is read", async () => {
  const job = await leasedJob();
  const unknown = counted(4);
  expect((await handleArtifactUpload(upload({ jobId: job.jobId, token: "t".repeat(40) }, unknown.stream), job.jobId, deps)).status).toBe(401);
  expect(unknown.pulled()).toBeLessThanOrEqual(1);
  await done(job);
  const late = counted(4);
  expect((await handleArtifactUpload(upload(job, late.stream), job.jobId, deps)).status).toBe(409);
  expect(late.pulled()).toBeLessThanOrEqual(1);
});

test("a job that is over, whose lease ran out, or whose run was cancelled can no longer store files", async () => {
  const finished = await leasedJob();
  await done(finished);
  const over = await handleArtifactUpload(upload(finished, PNG), finished.jobId, deps);
  expect(over.status).toBe(409);
  expect((await over.json()).error).toBe("the job is over");

  const expired = await leasedJob();
  await sql`update jobs set lease_until = now() - interval '1 minute' where id = ${expired.jobId}`.execute(t.db);
  expect((await handleArtifactUpload(upload(expired, PNG), expired.jobId, deps)).status).toBe(401);

  const cancelled = await leasedJob();
  await withOrg(t.db, "org-a", (tx) => cancelRun(tx, "org-a", cancelled.runId));
  const res = await handleArtifactUpload(upload(cancelled, PNG), cancelled.jobId, deps);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("the run is no longer active");
});

test("a job stores at most its share, also when uploads arrive at once", async () => {
  const busy = await leasedJob();
  await fill(busy, "org-a", MAX_ARTIFACTS_PER_JOB - 6);
  const answers = await Promise.all(Array.from({ length: 12 }, () => handleArtifactUpload(upload(busy, PNG), busy.jobId, deps)));
  expect(answers.map((r) => r.status).sort()).toEqual([...Array(6).fill(201), ...Array(6).fill(409)]);
  expect(await rowsOf(busy.jobId)).toBe(MAX_ARTIFACTS_PER_JOB);
  const refused = await handleArtifactUpload(upload(busy, PNG), busy.jobId, deps);
  expect((await refused.json()).error).toBe(`a job stores at most ${MAX_ARTIFACTS_PER_JOB} files`);
});

test("a file the bucket does not take leaves no row, and the runner is told to try again", async () => {
  const job = await leasedJob();
  const refusing: ArtifactStore = { ...store, put: async () => { throw new Error("the bucket is unavailable"); } };
  const res = await handleArtifactUpload(upload(job, PNG), job.jobId, { ...deps, artifacts: refusing });
  expect(res.status).toBe(503);
  expect((await res.json()).error).toMatch(/try again/);
  expect(await rowsOf(job.jobId)).toBe(0);
});

test("without storage configured, uploads answer 503", async () => {
  const job = await leasedJob();
  expect((await handleArtifactUpload(upload(job, PNG), job.jobId, { ...deps, artifacts: undefined })).status).toBe(503);
});

test("a short-lived link serves the file with its type, only to the workspace that owns it, which the database enforces too", async () => {
  const job = await leasedJob();
  const id = await stored(job);
  const link = await artifactLink(t.db, store, "org-a", id);
  expect(link).toMatch(/X-Amz-Expires=300/);
  expect(link).not.toMatch(/x-amz-checksum-mode/i);
  const res = await fetch(link!);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  expect(await artifactLink(t.db, store, "org-b", id)).toBeNull();
  expect(await artifactLink(t.db, store, "org-a", "00000000-0000-4000-8000-000000000000")).toBeNull();
  expect(await artifactLink(t.db, store, "org-a", "not-a-uuid")).toBeNull();
  expect(await withOrg(t.db, "org-b", (tx) => tx.selectFrom("artifacts").select("id").where("id", "=", id).execute())).toEqual([]);
});

test("a job handed back to the queue drops its files: no link, no share of the cap, and the cleanup removes them after a grace period", async () => {
  const job = await leasedJob();
  const id = await stored(job, PNG, { query: "kind=screenshot&finding=f1" });
  await releaseJobForShutdown(t.db, job.token, job.jobId);
  expect((await rowOf(id)).discarded_at).not.toBeNull();
  expect(await artifactLink(t.db, store, "org-a", id)).toBeNull();

  const again = await claimJob(t.db, keys);
  expect(again!.jobId).toBe(job.jobId);
  await fill(again!, "org-a", MAX_ARTIFACTS_PER_JOB - 1);
  expect((await handleArtifactUpload(upload(again!, PNG), again!.jobId, deps)).status).toBe(201);

  const key = (await rowOf(id)).storage_key;
  expect(await removeExpiredArtifacts(t.db, store)).toBe(0);
  expect(await objectKeys()).toContain(key);
  await sql`update artifacts set discarded_at = now() - interval '11 minutes' where id = ${id}`.execute(t.db);
  expect(await removeExpiredArtifacts(t.db, store)).toBe(1);
  expect(await objectKeys()).not.toContain(key);
});

test("files older than 30 days are removed with their rows; newer ones stay", async () => {
  const job = await leasedJob("org-b");
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(await stored(job));
  const [old, older, fresh] = ids as [string, string, string];
  await sql`update artifacts set created_at = now() - interval '31 days' where id in (${old}, ${older})`.execute(t.db);
  await sql`update artifacts set created_at = now() - interval '29 days' where id = ${fresh}`.execute(t.db);
  const keyOf = async (id: string) => (await sql<{ storage_key: string }>`select storage_key from artifacts where id = ${id}`.execute(t.db)).rows[0]!.storage_key;
  const [oldKey, olderKey, freshKey] = [await keyOf(old), await keyOf(older), await keyOf(fresh)];

  expect(await removeExpiredArtifacts(t.db, store, { batch: 1 })).toBe(2);
  const left = await sql<{ id: string }>`select id from artifacts where job_id = ${job.jobId}`.execute(t.db);
  expect(left.rows.map((r) => r.id)).toEqual([fresh]);
  const objects = await objectKeys();
  expect(objects).toContain(freshKey);
  expect(objects).not.toContain(oldKey);
  expect(objects).not.toContain(olderKey);
  expect(await removeExpiredArtifacts(t.db, store)).toBe(0);
});

test("a file the bucket fails to delete keeps its row for the next cleanup, which is logged once per run, and two cleanups at once remove every file", async () => {
  const job = await leasedJob("org-b");
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await stored(job));
  await sql`update artifacts set created_at = now() - interval '40 days' where job_id = ${job.jobId}`.execute(t.db);
  const stuckKey = (await sql<{ storage_key: string }>`select storage_key from artifacts where id = ${ids[0]!}`.execute(t.db)).rows[0]!.storage_key;
  const flaky: ArtifactStore = {
    ...store,
    remove: async (key) => {
      if (key === stuckKey) throw new Error("the bucket is unavailable");
      await store.remove(key);
    },
  };
  const logged: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
  const [a, b] = await Promise.all([removeExpiredArtifacts(t.db, flaky, { batch: 2 }), removeExpiredArtifacts(t.db, flaky, { batch: 2 })]);
  expect(a + b).toBe(3);
  const left = await sql<{ id: string }>`select id from artifacts where job_id = ${job.jobId}`.execute(t.db);
  expect(left.rows.map((r) => r.id)).toEqual([ids[0]]);
  expect(await objectKeys()).toContain(stuckKey);
  expect(await removeExpiredArtifacts(t.db, flaky, { batch: 1 })).toBe(0);
  const failures = () => logged.filter((l) => l.includes("expired artifacts could not be deleted"));
  await vi.waitFor(() => expect(failures()).toHaveLength(3));
  expect(JSON.parse(failures()[0]!)).toMatchObject({ failed: 1, error: { message: "the bucket is unavailable" } });
  expect(await removeExpiredArtifacts(t.db, store)).toBe(1);
});

test("a cleanup stops after a few failures instead of trying every expired file against a bucket that is down", async () => {
  const job = await leasedJob("org-b");
  await fill(job, "org-b", 25, "60 days");
  let attempts = 0;
  const down: ArtifactStore = { ...store, remove: async () => { attempts++; throw new Error("the bucket is unavailable"); } };
  const logged: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
  expect(await removeExpiredArtifacts(t.db, down, { batch: 4 })).toBe(0);
  expect(attempts).toBe(MAX_FAILURES_PER_RUN);
  await vi.waitFor(() => expect(logged).toHaveLength(1));
  expect(JSON.parse(logged[0]!)).toMatchObject({ msg: "expired artifacts could not be deleted", failed: MAX_FAILURES_PER_RUN });
  expect(await removeExpiredArtifacts(t.db, store)).toBe(25);
});
