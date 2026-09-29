import { ANSWER_UNUSABLE, JOB_STOPPED } from "@usetrawler/protocol";
import type { Database } from "../db/index.ts";
import { asSystem } from "../db/tenancy.ts";
import { modelKey } from "../credentials/credentials.ts";
import type { Keyring } from "../lib/secrets.ts";
import { bearer, readBody } from "../runner-api/handlers.ts";
import type { Price } from "../llm/prices.ts";
import { chatFetchFor, chatHeaders, endpointFor, LONGEST_EXPLANATION_READ, providerError, saysTheKeyIsInvalid, type Endpoint, type ProviderError } from "../llm/providers.ts";
import { InvalidJobToken, llmCallFor, LlmRefused, recordLlmUsage, type LlmCall } from "../runs/queue.ts";
import { affordableOutputTokens } from "../runs/runs.ts";
import { logError, scrubberWith } from "../server/log.ts";
import { FetchRefused } from "../setup/safe-fetch.ts";

export interface ProxyDeps {
  db: Database;
  keys: Keyring;
  openRouterUrl: string;
  trawlerKey?: string;
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
const unusable = (message: string) => failure(422, message, ANSWER_UNUSABLE);

class UpstreamTimeout extends Error {}

const KEY_REFUSED = "the provider refused the workspace key; an owner or admin can replace it in Settings";
const TRAWLER_KEY_REFUSED = "the provider refused Trawler's key; this run cannot go on, and Trawler has been told";
const TRAWLER_OUT_OF_CREDITS = "Trawler's model account is out of credits; this run cannot go on, and Trawler has been told";

async function endpointOf(deps: ProxyDeps, call: LlmCall): Promise<Endpoint | Response> {
  if (call.paidBy === "trawler") {
    if (!deps.trawlerKey) return failure(402, "Trawler cannot pay for model calls on this server");
    return endpointFor("openrouter", deps.trawlerKey, { openRouterUrl: deps.openRouterUrl });
  }
  const stored = await asSystem(deps.db, (tx) => modelKey(tx, call.orgId, deps.keys));
  if (!stored) return failure(402, "the workspace has no model key");
  if (stored.provider !== call.provider || (call.provider === "custom" && stored.baseUrl !== call.providerBaseUrl)) return failure(402, "the workspace key changed to another provider or endpoint; start a new run");
  return endpointFor(stored.provider, stored.key, { openRouterUrl: deps.openRouterUrl, customUrl: stored.baseUrl });
}
const refusedTheContent = (error: ProviderError | undefined) =>
  !!error && (Array.isArray(error.metadata?.reasons) || typeof error.metadata?.flagged_input === "string" || (typeof error.message === "string" && /moderat|flagged|guardrail/i.test(error.message)));

const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || (err.name === "AbortError" && err.cause instanceof Error && err.cause.name === "TimeoutError"));

async function forward(deps: ProxyDeps, endpoint: Endpoint, payload: unknown, signal: AbortSignal): Promise<Response> {
  const attempts = deps.attempts ?? 3;
  let last: Response | Error = new Error("no attempt made");
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chatFetchFor(endpoint, deps.fetch ?? fetch)(`${endpoint.baseUrl}/chat/completions`, {
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
      if (timedOut(err)) throw new UpstreamTimeout();
      if (err instanceof FetchRefused) throw err;
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
  if (price) allowed = Math.min(allowed, affordableOutputTokens(call.remainingUsd, price.completionUsdPerMtok));
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
  const endpoint = await endpointOf(deps, call);
  if (endpoint instanceof Response) return endpoint;
  const price = call.price;
  const maxTokens = outputAllowance(price, request.max_tokens ?? request.max_completion_tokens, call);
  if (maxTokens < 1) return jobStopped("the run has spent its budget");

  const openRouter = endpoint.provider === "openrouter";
  const fields = openRouter ? [...FORWARDED, ...OPENROUTER_ONLY] : FORWARDED;
  const payload = Object.fromEntries(fields.filter((field) => field in request).map((field) => [field, request[field]]));
  const extras = openRouter ? { usage: { include: true }, provider: { data_collection: "deny", allow_fallbacks: true } } : {};
  const guessedInputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(payload)) / 3);
  const chargeTheUnreadAnswer = () =>
    record(deps, call, { model: request.model as string, inputTokens: guessedInputTokens, outputTokens: maxTokens, costUsd: priced(price, guessedInputTokens, maxTokens) });
  let upstream: Response;
  try {
    upstream = await forward(deps, endpoint, { ...payload, max_tokens: maxTokens, ...extras }, req.signal);
  } catch (err) {
    if (err instanceof UpstreamTimeout) return failure(504, "the provider did not answer in time");
    if (req.signal.aborted) return failure(499, "the runner hung up");
    if (err instanceof FetchRefused && err.reason === "too_long" && err.status !== undefined && err.status >= 200 && err.status < 300) {
      await chargeTheUnreadAnswer();
      return unusable("the provider's answer was too large");
    }
    if (err instanceof FetchRefused && err.reason === "too_long" && err.status !== undefined) return failure(502, "the provider's answer was too large");
    return failure(502, "the provider could not be reached");
  }
  if (upstream.status === 402) {
    if (call.paidBy !== "trawler") return failure(402, "the provider account behind the workspace key is out of credits");
    await logError("Trawler's model account is out of credits", { orgId: call.orgId, runId: call.runId });
    return failure(402, TRAWLER_OUT_OF_CREDITS);
  }
  let text: string;
  try {
    text = await upstream.text();
  } catch (err) {
    if (upstream.ok) await chargeTheUnreadAnswer();
    if (req.signal.aborted) return failure(499, "the runner hung up");
    if (timedOut(err)) return failure(504, "the provider did not answer in time");
    return failure(502, "the provider could not be reached");
  }
  let parsed: { usage?: Usage; model?: unknown } | null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const error = providerError(parsed);
  if (upstream.status === 401 || saysTheKeyIsInvalid(upstream.status, error) || (upstream.status === 403 && !refusedTheContent(error))) {
    if (call.paidBy !== "trawler") return failure(402, KEY_REFUSED);
    await logError("the provider refused Trawler's model key", { orgId: call.orgId, runId: call.runId, status: upstream.status });
    return failure(402, TRAWLER_KEY_REFUSED);
  }
  if (!parsed || typeof parsed !== "object") {
    if (!upstream.ok) return failure(upstream.status, "the provider sent an unreadable answer");
    await chargeTheUnreadAnswer();
    return unusable("the provider sent an unreadable answer");
  }
  if (!upstream.ok || error) {
    const explanation = error?.message;
    const message = typeof explanation !== "string"
      ? `the provider answered ${upstream.status}`
      : explanation.length > LONGEST_EXPLANATION_READ
        ? `the provider answered ${upstream.status}; its explanation was too long to show`
        : scrubberWith([endpoint.key]).scrub(explanation).slice(0, 300);
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
