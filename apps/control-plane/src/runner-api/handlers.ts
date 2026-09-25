import { createHash, timingSafeEqual } from "node:crypto";
import { ARTIFACT_EXTENSIONS, ArtifactUploadSchema, EventBatchSchema, isArtifactContentType, JobCompletionSchema, MAX_ARTIFACT_BYTES, PROTOCOL_HEADER, PROTOCOL_VERSION } from "@usetrawler/protocol";
import { ArtifactNotStored, ArtifactRefused, checkArtifactUpload, hasSignatureOf, storeArtifact } from "../artifacts/artifacts.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { Database } from "../db/index.ts";
import type { Keyring } from "../lib/secrets.ts";
import { claimJob, completeJob, ForeignEvents, ingestEvents, InvalidJobToken, JobOver, releaseJob, releaseJobForShutdown } from "../runs/queue.ts";

export interface RunnerApiDeps {
  db: Database;
  keys: Keyring;
  runnerToken: string;
  claimWaitMs?: number;
  pollMs?: number;
  artifacts?: ArtifactStore;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const problem = (status: number, message: string, issues?: Array<{ path: PropertyKey[]; message: string }>) =>
  json({ error: message, ...(issues ? { issues: issues.slice(0, 5).map((i) => ({ path: i.path.map(String).join("."), message: i.message })) } : {}) }, status);

function protocolProblem(req: Request): Response | null {
  const version = req.headers.get(PROTOCOL_HEADER);
  if (version !== String(PROTOCOL_VERSION)) return problem(426, `this control plane speaks protocol ${PROTOCOL_VERSION}; upgrade the runner`);
  return null;
}

export function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+\/=-]{16,512})$/.exec(header);
  return match ? match[1]! : null;
}

export function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const MAX_BODY_BYTES = 2_000_000;

class BodyTooLarge extends Error {}

async function bytesOf(req: Request, maxBytes: number): Promise<Buffer> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) throw new BodyTooLarge();
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function body(req: Request, maxBytes: number): Promise<unknown> {
  const bytes = await bytesOf(req, maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function readBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<{ value: unknown } | { tooLarge: true }> {
  try {
    return { value: await body(req, maxBytes) };
  } catch (err) {
    if (err instanceof BodyTooLarge) return { tooLarge: true };
    throw err;
  }
}

export async function handleClaim(req: Request, deps: RunnerApiDeps): Promise<Response> {
  const wrongProtocol = protocolProblem(req);
  if (wrongProtocol) return wrongProtocol;
  const token = bearer(req);
  if (!token || !sameSecret(token, deps.runnerToken)) return problem(401, "unknown runner");
  const deadline = Date.now() + (deps.claimWaitMs ?? 25_000);
  while (!req.signal.aborted) {
    const job = await claimJob(deps.db, deps.keys);
    if (job && req.signal.aborted) {
      await releaseJob(deps.db, job);
      break;
    }
    if (job) return json(job);
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 1000));
  }
  return new Response(null, { status: 204 });
}

export async function handleEvents(req: Request, jobId: string, deps: RunnerApiDeps): Promise<Response> {
  const wrongProtocol = protocolProblem(req);
  if (wrongProtocol) return wrongProtocol;
  const token = bearer(req);
  if (!token || !UUID.test(jobId)) return problem(401, "invalid job token");
  const read = await readBody(req);
  if ("tooLarge" in read) return problem(413, "the request is too large");
  const parsed = EventBatchSchema.safeParse(read.value);
  if (!parsed.success) return problem(400, "invalid event batch", parsed.error.issues);
  try {
    return json(await ingestEvents(deps.db, token, parsed.data.events, jobId));
  } catch (err) {
    if (err instanceof InvalidJobToken) return problem(401, "invalid job token");
    if (err instanceof ForeignEvents) return problem(400, err.message);
    throw err;
  }
}

export async function handleComplete(req: Request, jobId: string, deps: RunnerApiDeps): Promise<Response> {
  const wrongProtocol = protocolProblem(req);
  if (wrongProtocol) return wrongProtocol;
  const token = bearer(req);
  if (!token || !UUID.test(jobId)) return problem(401, "invalid job token");
  const read = await readBody(req);
  if ("tooLarge" in read) return problem(413, "the request is too large");
  const parsed = JobCompletionSchema.safeParse(read.value);
  if (!parsed.success) return problem(400, "invalid completion", parsed.error.issues);
  try {
    await completeJob(deps.db, token, parsed.data, jobId);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidJobToken) return problem(401, "invalid job token");
    throw err;
  }
}

export async function handleRelease(req: Request, jobId: string, deps: RunnerApiDeps): Promise<Response> {
  const wrongProtocol = protocolProblem(req);
  if (wrongProtocol) return wrongProtocol;
  const token = bearer(req);
  if (!token || !UUID.test(jobId)) return problem(401, "invalid job token");
  try {
    await releaseJobForShutdown(deps.db, token, jobId);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidJobToken) return problem(401, "invalid job token");
    throw err;
  }
}

export async function handleArtifactUpload(req: Request, jobId: string, deps: RunnerApiDeps): Promise<Response> {
  const wrongProtocol = protocolProblem(req);
  if (wrongProtocol) return wrongProtocol;
  if (!deps.artifacts) return problem(503, "artifact storage is not configured on this server");
  const token = bearer(req);
  if (!token || !UUID.test(jobId)) return problem(401, "invalid job token");
  const upload = ArtifactUploadSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!upload.success) return problem(400, "invalid artifact", upload.error.issues);
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!isArtifactContentType(contentType)) return problem(415, `an artifact must be one of ${Object.keys(ARTIFACT_EXTENSIONS).join(", ")}`);
  const refused = (err: unknown) => {
    if (err instanceof InvalidJobToken) return problem(401, "invalid job token");
    if (err instanceof JobOver || err instanceof ArtifactRefused) return problem(409, err.message);
    if (err instanceof ArtifactNotStored) return problem(503, err.message);
    throw err;
  };
  try {
    await checkArtifactUpload(deps.db, token, jobId);
  } catch (err) {
    return refused(err);
  }
  let bytes: Buffer;
  try {
    bytes = await bytesOf(req, MAX_ARTIFACT_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLarge) return problem(413, `an artifact is at most ${MAX_ARTIFACT_BYTES} bytes`);
    throw err;
  }
  if (!hasSignatureOf(contentType, bytes)) return problem(415, `the file is not ${contentType}`);
  try {
    return json(await storeArtifact(deps.db, deps.artifacts, token, jobId, upload.data, { contentType, bytes }), 201);
  } catch (err) {
    return refused(err);
  }
}
