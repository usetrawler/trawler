import { keyLooksValid } from "../credentials/credentials.ts";
import { customUrlProblem, detectProvider, endpointFor, PROVIDERS, type Endpoint, type Provider } from "./providers.ts";

export interface KeyInput {
  key?: string;
  provider?: string;
  baseUrl?: string;
}

export function freshEndpoint(input: KeyInput, openRouterUrl: string): { endpoint: Endpoint } | { error: string; field: "key" | "baseUrl" } {
  const key = (input.key ?? "").trim();
  if (!keyLooksValid(key)) return { error: "That does not look like an API key. Copy it again from your provider.", field: "key" };
  const chosen = PROVIDERS.includes(input.provider as Provider) ? (input.provider as Provider) : null;
  const provider = chosen ?? detectProvider(key) ?? "custom";
  if (provider === "custom") {
    const baseUrl = (input.baseUrl ?? "").trim();
    const problem = customUrlProblem(baseUrl);
    if (problem) return { error: problem, field: "baseUrl" };
    return { endpoint: endpointFor("custom", key, { openRouterUrl, customUrl: baseUrl }) };
  }
  return { endpoint: endpointFor(provider, key, { openRouterUrl }) };
}

const LISTINGS_PER_WINDOW = 30;
const LISTING_WINDOW_MS = 10 * 60 * 1000;
const listings = new Map<string, number[]>();

export function withinListingLimit(userId: string, now = Date.now()): boolean {
  const recent = (listings.get(userId) ?? []).filter((t) => now - t < LISTING_WINDOW_MS);
  if (recent.length >= LISTINGS_PER_WINDOW) return false;
  listings.set(userId, [...recent, now]);
  return true;
}
