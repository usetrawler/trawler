import { JOB_STOPPED } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import { asSystem } from "../db/tenancy.ts";
import { modelKey } from "../credentials/credentials.ts";
import type { Keyring } from "../lib/secrets.ts";
import { bearer, readBody } from "../runner-api/handlers.ts";
import type { Price } from "../llm/prices.ts";
import { chatHeaders, endpointFor, fetchFor, LONGEST_EXPLANATION_READ, type Endpoint } from "../llm/providers.ts";
import { InvalidJobToken, llmCallFor, LlmRefused, recordLlmUsage, type LlmCall } from "../runs/queue.ts";
import { logError, scrubberWith } from "../server/log.ts";

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
const FORWARDED = ["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "seed", "stop", "frequency_penalty", "presence_penalty", "response_format"] as const;
const OPENROUTER_ONLY = ["top_k", "reasoning", "include_reasoning"] as const;
const inFlight = new Set<string>();

const failure = (status: number, message: string, type?: string) => Response.json({ error: { code: status, message, ...(type ? { type } : {}) } }, { status, headers: { "cache-control": "no-store" } });
const jobStopped = (message: string) => failure(402, message, JOB_STOPPED);

class UpstreamTimeout extends Error {}

async function forward(deps: ProxyDeps, endpoint: Endpoint, payload: unknown, signal: AbortSignal): Promise<Response> {
  const attempts = deps.attempts ?? 3;
  let last: Response | Error = new Error("no attempt made");
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchFor(endpoint, deps.fetch ?? fetch)(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: chatHeaders(endpoint),
        body: JSON.stringify(payload),
        redirect: "error",
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
const priced = (price: Price | null, input: number, output: number) => (price ? (input * price.promptUsdPerMtok + output * price.completionUsdPerMtok) / 1_000_000 : 0);

function outputAllowance(price: Price | null, requested: unknown, call: LlmCall): number {
  let allowed = Math.min(count(requested) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  if (price && price.completionUsdPerMtok > 0) allowed = Math.min(allowed, Math.floor((call.remainingUsd * 1_000_000) / price.completionUsdPerMtok));
  if (call.remainingTokens !== null) allowed = Math.min(allowed, call.remainingTokens);
  return allowed;
}

async function record(deps: ProxyDeps, call: LlmCall, usage: Parameters<typeof recordLlmUsage>[2]) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await recordLlmUsage(deps.db, call, usage);
    } catch (err) {
      if (attempt === 1) await logError("model usage could not be recorded", { orgId: call.orgId, runId: call.runId, jobId: call.jobId, costUsd: usage.costUsd, err });
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
    if (err instanceof LlmRefused) return jobStopped(err.message);
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
  const stored = await asSystem(deps.db, (tx) => modelKey(tx, call.orgId, deps.keys));
  if (!stored) return failure(402, "the workspace has no model key");
  if (stored.provider !== call.provider || (call.provider === "custom" && stored.baseUrl !== call.providerBaseUrl)) return failure(402, "the workspace key changed to another provider or endpoint; start a new run");
  const endpoint = endpointFor(stored.provider, stored.key, { openRouterUrl: deps.openRouterUrl, customUrl: stored.baseUrl });
  const price = call.price;
  const maxTokens = outputAllowance(price, request.max_tokens ?? request.max_completion_tokens, call);
  if (maxTokens < 1) return jobStopped("the run has spent its budget");

  const openRouter = stored.provider === "openrouter";
  const fields = openRouter ? [...FORWARDED, ...OPENROUTER_ONLY] : FORWARDED;
  const payload = Object.fromEntries(fields.filter((field) => field in request).map((field) => [field, request[field]]));
  const extras = openRouter ? { usage: { include: true }, provider: { data_collection: "deny", allow_fallbacks: true } } : {};
  let upstream: Response;
  try {
    upstream = await forward(deps, endpoint, { ...payload, max_tokens: maxTokens, ...extras }, req.signal);
  } catch (err) {
    if (err instanceof UpstreamTimeout) return failure(504, "the provider did not answer in time");
    if (req.signal.aborted) return failure(499, "the runner hung up");
    return failure(502, "the provider could not be reached");
  }
  if (upstream.status === 401 || upstream.status === 403) return failure(402, "the provider refused the workspace key; replace it on the plan page");
  if (upstream.status === 402) return failure(402, "the provider account behind the workspace key is out of credits");
  const text = await upstream.text();
  let parsed: { usage?: Usage; model?: unknown; error?: { message?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(upstream.ok ? 502 : upstream.status, "the provider sent an unreadable answer");
  }
  if (!parsed || typeof parsed !== "object") return failure(upstream.ok ? 502 : upstream.status, "the provider sent an unreadable answer");
  if (!upstream.ok || parsed.error) {
    const explanation = parsed.error?.message;
    const message = typeof explanation !== "string"
      ? `the provider answered ${upstream.status}`
      : explanation.length > LONGEST_EXPLANATION_READ
        ? `the provider answered ${upstream.status}; its explanation was too long to show`
        : scrubberWith([stored.key]).scrub(explanation).slice(0, 300);
    return failure(upstream.ok ? 502 : upstream.status, message);
  }
  const usage = parsed.usage ?? {};
  const inputTokens = count(usage.prompt_tokens);
  const outputTokens = count(usage.completion_tokens);
  await record(deps, call, {
    model: typeof parsed.model === "string" ? parsed.model : request.model,
    inputTokens,
    outputTokens,
    costUsd: Math.max(openRouter ? count(usage.cost) : 0, priced(price, inputTokens, outputTokens)),
  });
  return new Response(text, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
