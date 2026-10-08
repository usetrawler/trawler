import { IDEMPOTENCY_KEY_HEADER, StartRunRequestSchema } from "@usetrawler/protocol";
import { tokenWorkspace } from "../server/api-token.ts";
import type { TokenHolder } from "../api-tokens/tokens.ts";
import { readRunFor, startRunFor, stopRunFor, type Outcome, type RunApiDeps, type RunPrincipal } from "./service.ts";

export type { RunApiDeps } from "./service.ts";

const NO_STORE = { "cache-control": "no-store" };
const answer = (outcome: Outcome<unknown>): Response => outcome.ok
  ? Response.json(outcome.value, { status: outcome.status, headers: outcome.replayed ? { ...NO_STORE, "idempotent-replayed": "true" } : NO_STORE })
  : Response.json({ error: outcome.error, ...(outcome.code ? { code: outcome.code } : {}) }, { status: outcome.status, headers: NO_STORE });

const principalOf = (holder: TokenHolder): RunPrincipal => ({
  subject: "API token", orgId: holder.orgId, projectId: holder.projectId, actor: `api-token:${holder.tokenId}`, can: { read: true, control: true },
});

export async function handleStartRun(req: Request, deps: RunApiDeps): Promise<Response> {
  const auth = await tokenWorkspace(req.headers, deps.db);
  if (!auth.ok) return auth.response;
  const raw = await req.json().catch(() => undefined);
  const parsed = StartRunRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json({ error: `Invalid request: ${issue ? `${issue.path.join(".") || "body"} ${issue.message}` : "unreadable body"}.` }, { status: 400, headers: NO_STORE });
  }
  const key = req.headers.get(IDEMPOTENCY_KEY_HEADER);
  return answer(await startRunFor(principalOf(auth.holder), parsed.data, deps, key === null ? {} : { idempotencyKey: key }));
}

export async function handleGetRun(req: Request, id: string, deps: RunApiDeps): Promise<Response> {
  const auth = await tokenWorkspace(req.headers, deps.db);
  if (!auth.ok) return auth.response;
  return answer(await readRunFor(principalOf(auth.holder), id, deps));
}

export async function handleStopRun(req: Request, id: string, deps: RunApiDeps): Promise<Response> {
  const auth = await tokenWorkspace(req.headers, deps.db);
  if (!auth.ok) return auth.response;
  return answer(await stopRunFor(principalOf(auth.holder), id, deps));
}
