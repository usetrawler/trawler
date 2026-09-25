import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { ARTIFACT_EXTENSIONS, MAX_ARTIFACTS_PER_JOB, type ArtifactContentType, type ArtifactUpload } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { leasedJobFor } from "../runs/queue.ts";
import type { ArtifactStore } from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ArtifactRefused extends Error {}

const startsWith = (bytes: Uint8Array, prefix: number[], offset = 0) => bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const SIGNATURES: Record<ArtifactContentType, (bytes: Uint8Array) => boolean> = {
  "image/png": (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/webp": (bytes) => startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8),
};

export const hasSignatureOf = (type: ArtifactContentType, bytes: Uint8Array) => SIGNATURES[type](bytes);

export async function storeArtifact(
  db: Database,
  store: ArtifactStore,
  token: string,
  jobId: string,
  upload: ArtifactUpload,
  file: { contentType: ArtifactContentType; bytes: Uint8Array },
): Promise<{ id: string }> {
  const target = await asSystem(db, async (tx) => {
    const job = await leasedJobFor(tx, token, jobId);
    const { stored } = await tx.selectFrom("artifacts").select(sql<number>`count(*)::int`.as("stored")).where("job_id", "=", job.id).executeTakeFirstOrThrow();
    if (stored >= MAX_ARTIFACTS_PER_JOB) throw new ArtifactRefused(`a job stores at most ${MAX_ARTIFACTS_PER_JOB} files`);
    const findingKey = job.kind === "role_session" ? (upload.finding ? `${job.persona_key}:${upload.finding}` : null) : job.finding_key;
    return { orgId: job.org_id, runId: job.run_id, jobId: job.id, findingKey };
  });
  const id = randomUUID();
  const key = `orgs/${target.orgId}/runs/${target.runId}/${id}.${ARTIFACT_EXTENSIONS[file.contentType]}`;
  await store.put(key, file.bytes, file.contentType);
  await asSystem(db, (tx) =>
    tx.insertInto("artifacts").values({
      id, org_id: target.orgId, run_id: target.runId, job_id: target.jobId, finding_key: target.findingKey,
      kind: upload.kind, content_type: file.contentType, size_bytes: file.bytes.byteLength, storage_key: key,
    }).execute(),
  );
  return { id };
}

export async function artifactLink(db: Database, store: ArtifactStore, orgId: string, id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  const artifact = await withOrg(db, orgId, (tx) => tx.selectFrom("artifacts").select("storage_key").where("id", "=", id).where("org_id", "=", orgId).executeTakeFirst());
  return artifact ? store.link(artifact.storage_key) : null;
}
