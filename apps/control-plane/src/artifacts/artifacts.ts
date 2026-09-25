import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { ARTIFACT_EXTENSIONS, MAX_ARTIFACTS_PER_JOB, type ArtifactContentType, type ArtifactUpload } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import { asSystem, withOrg, type Tx } from "../db/tenancy.ts";
import { leasedJobFor, storable } from "../runs/queue.ts";
import { logError } from "../server/log.ts";
import { DISCARD_GRACE_MINUTES } from "./cleanup.ts";
import type { ArtifactStore } from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ArtifactRefused extends Error {}
export class ArtifactNotStored extends Error {}

const startsWith = (bytes: Uint8Array, prefix: number[], offset = 0) => bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const SIGNATURES: Record<ArtifactContentType, (bytes: Uint8Array) => boolean> = {
  "image/png": (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/webp": (bytes) => startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8),
};

export const hasSignatureOf = (type: ArtifactContentType, bytes: Uint8Array) => SIGNATURES[type](bytes);

async function jobWithRoom(tx: Tx, token: string, jobId: string) {
  const job = await leasedJobFor(tx, token, jobId);
  const { stored } = await tx
    .selectFrom("artifacts")
    .select(sql<number>`count(*)::int`.as("stored"))
    .where("job_id", "=", job.id)
    .where((eb) => eb.or([
      eb.and([eb("stored_at", "is not", null), eb("discarded_at", "is", null)]),
      eb.and([eb("stored_at", "is", null), eb("created_at", ">", sql<Date>`now() - make_interval(mins => ${DISCARD_GRACE_MINUTES})`)]),
    ]))
    .executeTakeFirstOrThrow();
  if (stored >= MAX_ARTIFACTS_PER_JOB) throw new ArtifactRefused(`a job stores at most ${MAX_ARTIFACTS_PER_JOB} files`);
  return job;
}

const removeFileWithoutRow = (store: ArtifactStore, key: string, job: { org_id: string; run_id: string; id: string }) =>
  store.remove(key).catch((err: unknown) => logError("an artifact's file could not be removed", { orgId: job.org_id, runId: job.run_id, jobId: job.id, err }));

export async function checkArtifactUpload(db: Database, token: string, jobId: string): Promise<void> {
  await asSystem(db, (tx) => jobWithRoom(tx, token, jobId));
}

export async function storeArtifact(
  db: Database,
  store: ArtifactStore,
  token: string,
  jobId: string,
  upload: ArtifactUpload,
  file: { contentType: ArtifactContentType; bytes: Uint8Array },
): Promise<{ id: string }> {
  const id = randomUUID();
  const { job, key } = await asSystem(db, async (tx) => {
    const job = await jobWithRoom(tx, token, jobId);
    const finding = upload.finding === undefined ? "" : storable(upload.finding);
    const key = `orgs/${job.org_id}/runs/${job.run_id}/${id}.${ARTIFACT_EXTENSIONS[file.contentType]}`;
    await tx.insertInto("artifacts").values({
      id, org_id: job.org_id, run_id: job.run_id, job_id: job.id,
      finding_key: job.kind === "role_session" ? (finding ? `${job.persona_key}:${finding}` : null) : job.finding_key,
      kind: upload.kind, content_type: file.contentType, size_bytes: file.bytes.byteLength, storage_key: key,
    }).execute();
    return { job, key };
  });
  try {
    await store.put(key, file.bytes, file.contentType);
  } catch (err) {
    const discarded = await asSystem(db, (tx) => tx.updateTable("artifacts").set({ discarded_at: new Date() }).where("id", "=", id).executeTakeFirst()).catch(() => undefined);
    if (discarded?.numUpdatedRows === 0n) await removeFileWithoutRow(store, key, job);
    await logError("an artifact could not be stored", { orgId: job.org_id, runId: job.run_id, jobId: job.id, err });
    throw new ArtifactNotStored("the bucket did not take the file; try again", { cause: err });
  }
  const { numUpdatedRows } = await asSystem(db, (tx) => tx.updateTable("artifacts").set({ stored_at: new Date() }).where("id", "=", id).executeTakeFirst());
  if (numUpdatedRows === 0n) {
    await removeFileWithoutRow(store, key, job);
    throw new ArtifactNotStored("the file was cleaned up while it was being stored; try again");
  }
  return { id };
}

export async function artifactLink(db: Database, store: ArtifactStore, orgId: string, id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  const artifact = await withOrg(db, orgId, (tx) =>
    tx.selectFrom("artifacts").select("storage_key").where("id", "=", id).where("org_id", "=", orgId).where("stored_at", "is not", null).where("discarded_at", "is", null).executeTakeFirst(),
  );
  return artifact ? store.link(artifact.storage_key) : null;
}
