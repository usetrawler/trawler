export const PROVIDERS = ["openrouter", "openai", "anthropic", "google", "custom"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", google: "Google", custom: "OpenAI-compatible" };

const FIXED_URL: Record<Exclude<Provider, "openrouter" | "custom">, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

const PRICE_PREFIX: Partial<Record<Provider, string>> = { openai: "openai", anthropic: "anthropic", google: "google" };

export const PREFERRED_MODELS: Record<Provider, string[]> = {
  openrouter: ["deepseek/deepseek-v4.1-flash", "google/gemini-3.5-flash", "anthropic/claude-haiku-4.5"],
  openai: ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-5"],
  google: ["gemini-3.5-flash", "gemini-2.5-flash"],
  custom: [],
};

export function detectProvider(key: string): Exclude<Provider, "custom"> | null {
  const k = key.trim();
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("AIza")) return "google";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

export interface Endpoint {
  provider: Provider;
  baseUrl: string;
  key: string;
}

export function endpointFor(provider: Provider, key: string, opts: { openRouterUrl: string; customUrl?: string | null }): Endpoint {
  if (provider === "openrouter") return { provider, key, baseUrl: opts.openRouterUrl };
  if (provider === "custom") {
    if (!opts.customUrl) throw new Error("a custom provider needs its base URL");
    return { provider, key, baseUrl: opts.customUrl.replace(/\/+$/, "") };
  }
  return { provider, key, baseUrl: FIXED_URL[provider] };
}

export function customUrlProblem(url: string): string | null {
  if (!URL.canParse(url)) return "Enter the provider's base URL, for example https://api.example.com/v1.";
  const u = new URL(url);
  if (u.protocol !== "https:") return "The base URL must use https.";
  if (u.username || u.password) return "Put the key in the key field, not in the URL.";
  return null;
}

function authHeaders(endpoint: Endpoint): Record<string, string> {
  if (endpoint.provider === "anthropic") return { "x-api-key": endpoint.key, "anthropic-version": "2023-06-01", authorization: `Bearer ${endpoint.key}` };
  return { authorization: `Bearer ${endpoint.key}` };
}

export function chatHeaders(endpoint: Endpoint): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(endpoint), ...(endpoint.provider === "openrouter" ? { "x-title": "Trawler" } : {}) };
}

export async function listModels(endpoint: Endpoint, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${endpoint.baseUrl}/models`, { headers: authHeaders(endpoint), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ProviderRefused(res.status);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? []).map((m) => (typeof m.id === "string" ? m.id.replace(/^models\//, "") : "")).filter((id) => id && id.length <= 200);
  return [...new Set(ids)].sort();
}

export class ProviderRefused extends Error {
  constructor(readonly status: number) {
    super(`the provider answered ${status}`);
  }
}

export type KeyCheck = { ok: true } | { ok: false; reason: "key" | "model" | "unavailable"; detail?: string };

export async function checkModelCall(endpoint: Endpoint, model: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const res = await fetchImpl(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(endpoint),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 5, ...(endpoint.provider === "openrouter" ? { provider: { data_collection: "deny" } } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true };
    const detail = await res.text().then((t) => { try { return String(JSON.parse(t)?.error?.message ?? "").slice(0, 200); } catch { return ""; } });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "key", detail };
    if (res.status === 400 || res.status === 404 || res.status === 422) return { ok: false, reason: "model", detail };
    return { ok: false, reason: "unavailable", detail };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export function priceKey(provider: Provider, model: string): string | null {
  if (provider === "openrouter") return model;
  const prefix = PRICE_PREFIX[provider];
  if (!prefix) return null;
  const normalised = model.replace(/-\d{8}$/, "").replace(/-latest$/, "").replace(/(\d)-(\d)/g, "$1.$2");
  return `${prefix}/${normalised}`;
}
