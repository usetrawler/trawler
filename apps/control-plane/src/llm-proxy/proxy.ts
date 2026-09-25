import type { Database } from "../db/index.ts";
import { asSystem } from "../db/tenancy.ts";
import { openRouterKey } from "../credentials/credentials.ts";
import type { Keyring } from "../lib/secrets.ts";
import { bearer, readBody } from "../runner-api/handlers.ts";
import { runModel } from "../runs/catalog.ts";
import type { RunModel } from "../runs/models.ts";
import { InvalidJobToken, llmCallFor, LlmRefused, recordLlmUsage, type LlmCall } from "../runs/queue.ts";

export interface ProxyDeps {
  db: Database;
  keys: Keyring;
  openRouterUrl: string;
  fetch?: typeof fetch;
  retryBaseMs?: number;
  attempts?: number;
}

const MAX_REQUEST_BYTES = 8_000_000;
const MAX_OUTPUT_TOKENS = 16_000;
const UPSTREAM_TIMEOUT_MS = 180_000;
const FORWARDED = ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "top_k", "seed", "stop", "frequency_penalty", "presence_penalty", "response_format", "reasoning", "include_reasoning"] as const;
const inFlight = new Set<string>();

const failure = (status: number, message: string) => Response.json({ error: { code: status, message } }, { status, headers: { "cache-control": "no-store" } });

class UpstreamTimeout extends Error {}

async function forward(deps: ProxyDeps, key: string, payload: unknown, signal: AbortSignal): Promise<Response> {
  const attempts = deps.attempts ?? 3;
  let last: Response | Error = new Error("no attempt made");
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await (deps.fetch ?? fetch)(`${deps.openRouterUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "Trawler" },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
      if (res.status !== 429 && res.status !== 502 && res.status !== 503) return res;
      last = res;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof Error && err.name === "TimeoutError") throw new UpstreamTimeout();
      last = err instanceof Error ? err : new Error(String(err));
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, (deps.retryBaseMs ?? 1000) * 2 ** i * (0.5 + Math.random())));
  }
  if (last instanceof Response) return last;
  throw last;
}

type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
const priced = (model: RunModel | null, input: number, output: number) => (model ? (input * model.promptUsdPerMtok + output * model.completionUsdPerMtok) / 1_000_000 : 0);

function outputAllowance(model: RunModel | null, requested: unknown, remainingUsd: number): number {
  const asked = Math.min(count(requested) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  if (!model || model.completionUsdPerMtok <= 0) return asked;
  return Math.min(asked, Math.floor((remainingUsd * 1_000_000) / model.completionUsdPerMtok));
}

async function record(deps: ProxyDeps, call: LlmCall, usage: Parameters<typeof recordLlmUsage>[2]) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await recordLlmUsage(deps.db, call, usage);
    } catch (err) {
      if (attempt === 1) console.error("model usage could not be recorded", { runId: call.runId, jobId: call.jobId, costUsd: usage.costUsd, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function handleChatCompletions(req: Request, deps: ProxyDeps): Promise<Response> {
  const token = bearer(req);
  if (!token) return failure(401, "a job token is required");
  let call: LlmCall;
  try {
    call = await llmCallFor(deps.db, token);
  } catch (err) {
    if (err instanceof InvalidJobToken) return failure(401, "invalid or expired job token");
    if (err instanceof LlmRefused) return failure(402, err.message);
    throw err;
  }
  if (inFlight.has(call.jobId)) return failure(429, "one model call at a time per job");
  inFlight.add(call.jobId);
  try {
    return await proxied(req, deps, call);
  } finally {
    inFlight.delete(call.jobId);
  }
}

async function proxied(req: Request, deps: ProxyDeps, call: LlmCall): Promise<Response> {
  const read = await readBody(req, MAX_REQUEST_BYTES);
  if ("tooLarge" in read) return failure(413, "the request is too large");
  const body = read.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400, "expected a JSON chat completion request");
  const request = body as Record<string, unknown>;
  if (request.stream !== undefined && request.stream !== false) return failure(400, "streaming is not supported");
  if (typeof request.model !== "string" || !call.models.includes(request.model)) return failure(400, `this job may only use ${call.models.join(" or ")}`);
  const [key, model] = await Promise.all([asSystem(deps.db, (tx) => openRouterKey(tx, call.orgId, deps.keys)), runModel(deps.db, request.model)]);
  if (!key) return failure(402, "the organisation has no OpenRouter key");
  const maxTokens = outputAllowance(model, request.max_tokens ?? request.max_completion_tokens, call.remainingUsd);
  if (maxTokens < 1) return failure(402, "the run has spent its budget");

  const payload = Object.fromEntries(FORWARDED.filter((field) => field in request).map((field) => [field, request[field]]));
  let upstream: Response;
  try {
    upstream = await forward(deps, key, { ...payload, max_tokens: maxTokens, usage: { include: true }, provider: { data_collection: "deny", allow_fallbacks: true } }, req.signal);
  } catch (err) {
    if (err instanceof UpstreamTimeout) return failure(504, "OpenRouter did not answer in time");
    if (req.signal.aborted) return failure(499, "the runner hung up");
    return failure(502, "OpenRouter could not be reached");
  }
  if (upstream.status === 401 || upstream.status === 403) return failure(402, "OpenRouter refused the organisation's key; replace it on the plan page");
  if (upstream.status === 402) return failure(402, "the organisation's OpenRouter account is out of credits");
  const text = await upstream.text();
  let parsed: { usage?: Usage; model?: unknown; error?: { message?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(502, "OpenRouter sent an unreadable answer");
  }
  if (!upstream.ok || parsed.error) {
    const message = typeof parsed.error?.message === "string" ? parsed.error.message.slice(0, 300) : `OpenRouter answered ${upstream.status}`;
    return failure(upstream.ok ? 502 : upstream.status, message);
  }
  const usage = parsed.usage ?? {};
  const inputTokens = count(usage.prompt_tokens);
  const outputTokens = count(usage.completion_tokens);
  await record(deps, call, {
    model: typeof parsed.model === "string" ? parsed.model : request.model,
    inputTokens,
    outputTokens,
    costUsd: Math.max(count(usage.cost), priced(model, inputTokens, outputTokens)),
  });
  return new Response(text, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
