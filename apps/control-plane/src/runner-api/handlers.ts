import { createHash, timingSafeEqual } from "node:crypto";
import { EventBatchSchema, JobCompletionSchema, PROTOCOL_HEADER, PROTOCOL_VERSION } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import type { Keyring } from "../lib/secrets.ts";
import { claimJob, completeJob, ForeignEvents, ingestEvents, InvalidJobToken, releaseJob } from "../runs/queue.ts";

export interface RunnerApiDeps {
  db: Database;
  keys: Keyring;
  runnerToken: string;
  claimWaitMs?: number;
  pollMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const problem = (status: number, message: string) => json({ error: message }, status);

function protocolProblem(req: Request): Response | null {
  const version = req.headers.get(PROTOCOL_HEADER);
  if (version !== String(PROTOCOL_VERSION)) return problem(426, `this control plane speaks protocol ${PROTOCOL_VERSION}; upgrade the runner`);
  return null;
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~+\/=-]{16,512})$/.exec(header);
  return match ? match[1]! : null;
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const MAX_BODY_BYTES = 2_000_000;

class BodyTooLarge extends Error {}

async function body(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new BodyTooLarge();
  if (!req.body) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function readBody(req: Request): Promise<{ value: unknown } | { tooLarge: true }> {
  try {
    return { value: await body(req) };
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
  if (!parsed.success) return problem(400, "invalid event batch");
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
  if (!parsed.success) return problem(400, "invalid completion");
  try {
    await completeJob(deps.db, token, parsed.data, jobId);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof InvalidJobToken) return problem(401, "invalid job token");
    throw err;
  }
}
