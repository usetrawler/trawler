import { priceKey, type Provider } from "./providers.ts";

export interface Price {
  promptUsdPerMtok: number;
  completionUsdPerMtok: number;
}

const TTL_MS = 60 * 60 * 1000;
const MAX_USD_PER_MTOK = 100_000;
let cache: { at: number; prices: Map<string, Price> } | undefined;
let loading: Promise<Map<string, Price>> | undefined;

const usd = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : NaN;
};

export function parseOpenRouterPrices(body: unknown): Map<string, Price> {
  const prices = new Map<string, Price>();
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return prices;
  for (const item of data as Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown; overrides?: Array<{ prompt?: unknown; completion?: unknown }> } }>) {
    if (typeof item?.id !== "string" || !item.pricing) continue;
    const all = [item.pricing, ...(Array.isArray(item.pricing.overrides) ? item.pricing.overrides : [])];
    const prompt = Math.max(...all.map((p) => usd(p.prompt)));
    const completion = Math.max(...all.map((p) => usd(p.completion)));
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt > MAX_USD_PER_MTOK || completion > MAX_USD_PER_MTOK) continue;
    prices.set(item.id, { promptUsdPerMtok: prompt, completionUsdPerMtok: completion });
  }
  return prices;
}

export async function openRouterPrices(openRouterUrl: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Map<string, Price>> {
  if (cache && now - cache.at < TTL_MS) return cache.prices;
  loading ??= fetchImpl(`${openRouterUrl}/models`, { signal: AbortSignal.timeout(10_000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
      const prices = parseOpenRouterPrices(await res.json());
      cache = { at: now, prices };
      return prices;
    })
    .catch(() => cache?.prices ?? new Map<string, Price>())
    .finally(() => (loading = undefined));
  return loading;
}

export interface PriceRange {
  low: Price;
  high: Price;
}

const MAX_RANGES = 500;
const ranges = new Map<string, { at: number; range: PriceRange | null }>();

export function parseEndpointPrices(body: unknown): PriceRange | null {
  const endpoints = (body as { data?: { endpoints?: unknown } })?.data?.endpoints;
  if (!Array.isArray(endpoints)) return null;
  const prices = (endpoints as Array<{ pricing?: { prompt?: unknown; completion?: unknown } }>)
    .map((e) => ({ promptUsdPerMtok: usd(e?.pricing?.prompt), completionUsdPerMtok: usd(e?.pricing?.completion) }))
    .filter((p) => Number.isFinite(p.promptUsdPerMtok) && Number.isFinite(p.completionUsdPerMtok) && p.promptUsdPerMtok <= MAX_USD_PER_MTOK && p.completionUsdPerMtok <= MAX_USD_PER_MTOK);
  if (prices.length === 0) return null;
  const prompt = prices.map((p) => p.promptUsdPerMtok);
  const completion = prices.map((p) => p.completionUsdPerMtok);
  return {
    low: { promptUsdPerMtok: Math.min(...prompt), completionUsdPerMtok: Math.min(...completion) },
    high: { promptUsdPerMtok: Math.max(...prompt), completionUsdPerMtok: Math.max(...completion) },
  };
}

export async function openRouterPriceRange(openRouterUrl: string, model: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<PriceRange | null> {
  const cached = ranges.get(model);
  if (cached && now - cached.at < TTL_MS) return cached.range;
  const segments = model.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const path = segments.map(encodeURIComponent).join("/");
  const answer = await fetchImpl(`${openRouterUrl}/models/${path}/endpoints`, { signal: AbortSignal.timeout(10_000) })
    .then(async (res) => (res.ok ? { range: parseEndpointPrices(await res.json()) } : res.status === 404 ? { range: null } : undefined))
    .catch(() => undefined);
  if (!answer) return null;
  const { range } = answer;
  if (ranges.size >= MAX_RANGES) ranges.delete(ranges.keys().next().value!);
  ranges.set(model, { at: now, range });
  return range;
}

export async function priceFor(provider: Provider, model: string, openRouterUrl: string, fetchImpl?: typeof fetch): Promise<Price | null> {
  const key = priceKey(provider, model);
  if (!key) return null;
  return (await openRouterPrices(openRouterUrl, fetchImpl)).get(key) ?? null;
}

export function resetPriceCache() {
  cache = undefined;
  ranges.clear();
}
