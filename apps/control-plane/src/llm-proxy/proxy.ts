import type { Database } from "../db/index.ts";
import { asSystem } from "../db/tenancy.ts";
import { openRouterKey } from "../credentials/credentials.ts";
import type { Keyring } from "../lib/secrets.ts";
import { bearer, readBody } from "../runner-api/handlers.ts";
import { InvalidJobToken, llmCallFor, LlmRefused, recordLlmUsage } from "../runs/queue.ts";

export interface ProxyDeps {
  db: Database;
  keys: Keyring;
  openRouterUrl: string;
  fetch?: typeof fetch;
  retryBaseMs?: number;
  attempts?: number;
}

const MAX_REQUEST_BYTES = 8_000_000;
const UPSTREAM_TIMEOUT_MS = 300_000;

const failure = (status: number, message: string) => Response.json({ error: { code: status, message } }, { status, headers: { "cache-control": "no-store" } });

async function forward(deps: ProxyDeps, key: string, payload: unknown): Promise<Response> {
  const attempts = deps.attempts ?? 3;
  let last: Response | Error = new Error("no attempt made");
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await (deps.fetch ?? fetch)(`${deps.openRouterUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "Trawler" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.status !== 429 && res.status < 500) return res;
      last = res;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, (deps.retryBaseMs ?? 1000) * 2 ** i * (0.5 + Math.random())));
  }
  if (last instanceof Response) return last;
  throw last;
}

type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export async function handleChatCompletions(req: Request, deps: ProxyDeps): Promise<Response> {
  const token = bearer(req);
  if (!token) return failure(401, "a job token is required");
  let call;
  try {
    call = await llmCallFor(deps.db, token);
  } catch (err) {
    if (err instanceof InvalidJobToken) return failure(401, "invalid or expired job token");
    if (err instanceof LlmRefused) return failure(402, err.message);
    throw err;
  }
  const read = await readBody(req, MAX_REQUEST_BYTES);
  if ("tooLarge" in read) return failure(413, "the request is too large");
  const body = read.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400, "expected a JSON chat completion request");
  const request = body as Record<string, unknown>;
  if (request.stream) return failure(400, "streaming is not supported");
  if (typeof request.model !== "string" || !call.models.includes(request.model)) return failure(400, `this job may only use ${call.models.join(" or ")}`);
  const key = await asSystem(deps.db, (tx) => openRouterKey(tx, call.orgId, deps.keys));
  if (!key) return failure(402, "the organisation has no OpenRouter key");

  const provider = request.provider && typeof request.provider === "object" ? request.provider : {};
  const upstream = await forward(deps, key, { ...request, usage: { include: true }, provider: { ...provider, data_collection: "deny" } });
  const text = await upstream.text();
  if (upstream.status === 401 || upstream.status === 403) return failure(402, "OpenRouter refused the organisation's key; replace it on the plan page");
  if (upstream.status === 402) return failure(402, "the organisation's OpenRouter account is out of credits");
  if (upstream.ok) {
    let usage: Usage = {};
    let model = request.model;
    try {
      const parsed = JSON.parse(text) as { usage?: Usage; model?: unknown };
      usage = parsed.usage ?? {};
      if (typeof parsed.model === "string") model = parsed.model;
    } catch {
      return failure(502, "OpenRouter sent an unreadable answer");
    }
    await recordLlmUsage(deps.db, call, { model, inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens), costUsd: count(usage.cost) });
  }
  return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}
