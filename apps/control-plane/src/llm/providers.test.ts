import { expect, test } from "vitest";
import { checkModelCall, detectProvider, endpointFor, listModels, priceKey, PROVIDER_LABEL, PROVIDERS } from "./providers.ts";
import { providerArticle } from "./provider-kinds.ts";
import { parseOpenRouterPrices } from "./prices.ts";

test("each provider's name takes the article it is spoken with", () => {
  expect(PROVIDERS.map((p) => `${providerArticle(p)} ${PROVIDER_LABEL[p]}`)).toEqual(["an OpenRouter", "an OpenAI", "an Anthropic", "a Google", "an OpenAI-compatible"]);
});

test("a key's provider is recognised from its format", () => {
  expect(detectProvider("sk-or-v1-abc")).toBe("openrouter");
  expect(detectProvider("sk-ant-api03-abc")).toBe("anthropic");
  expect(detectProvider("AIzaSyD-abc")).toBe("google");
  expect(detectProvider("sk-proj-abc")).toBe("openai");
  expect(detectProvider("sk-abc")).toBe("openai");
  expect(detectProvider("gsk_abc")).toBeNull();
});

test("each provider has its OpenAI-compatible endpoint; a custom one needs its URL", () => {
  expect(endpointFor("openai", "k", { openRouterUrl: "https://or" }).baseUrl).toBe("https://api.openai.com/v1");
  expect(endpointFor("google", "k", { openRouterUrl: "https://or" }).baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
  expect(endpointFor("openrouter", "k", { openRouterUrl: "https://or" }).baseUrl).toBe("https://or");
  expect(endpointFor("custom", "k", { openRouterUrl: "https://or", customUrl: "https://x.test/v1/" }).baseUrl).toBe("https://x.test/v1");
  expect(() => endpointFor("custom", "k", { openRouterUrl: "https://or" })).toThrow();
});

test("provider model ids map onto OpenRouter's price list", () => {
  expect(priceKey("anthropic", "claude-haiku-4-5-20251001")).toBe("anthropic/claude-haiku-4.5");
  expect(priceKey("openai", "gpt-5-mini")).toBe("openai/gpt-5-mini");
  expect(priceKey("google", "gemini-3.5-flash")).toBe("google/gemini-3.5-flash");
  expect(priceKey("openrouter", "deepseek/deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
  expect(priceKey("custom", "llama")).toBeNull();
  const prices = parseOpenRouterPrices({ data: [
    { id: "a/x", pricing: { prompt: "0.0000001", completion: "0.0000004", overrides: [{ prompt: "0.0000002", completion: "0.0000008" }] } },
    { id: "a/free", pricing: { prompt: "-1", completion: "-1" } },
    { id: "a/empty", pricing: { prompt: "", completion: null } },
  ] });
  expect(prices.get("a/x")).toEqual({ promptUsdPerMtok: expect.closeTo(0.2, 9), completionUsdPerMtok: expect.closeTo(0.8, 9) });
  expect(prices.has("a/free")).toBe(false);
  expect(prices.has("a/empty")).toBe(false);
});

test("models are listed with the key, and a start check tells a bad key from a bad model", async () => {
  const seen: Array<{ url: string; headers: Headers; body?: string }> = [];
  const fake = (status: number, body: unknown): typeof fetch => async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body as string | undefined });
    return new Response(JSON.stringify(body), { status });
  };
  const anthropic = endpointFor("anthropic", "sk-ant-x", { openRouterUrl: "" });
  expect(await listModels(anthropic, fake(200, { data: [{ id: "claude-b" }, { id: "claude-a" }] }))).toEqual(["claude-a", "claude-b"]);
  expect(seen[0]!.headers.get("x-api-key")).toBe("sk-ant-x");
  const google = endpointFor("google", "AIza-x", { openRouterUrl: "" });
  expect(await listModels(google, fake(200, { data: [{ id: "models/gemini-3.5-flash" }] }))).toEqual(["gemini-3.5-flash"]);
  expect(await checkModelCall(google, "gemini-3.5-flash", fake(200, {}))).toEqual({ ok: true });
  expect(JSON.parse(seen.at(-1)!.body!)).toMatchObject({ model: "gemini-3.5-flash", max_tokens: 5 });
  expect(await checkModelCall(google, "x", fake(401, { error: { message: "API key not valid" } }))).toEqual({ ok: false, reason: "key", detail: "API key not valid" });
  expect(await checkModelCall(google, "x", fake(404, { error: { message: "model not found" } }))).toMatchObject({ ok: false, reason: "model" });
  expect(await checkModelCall(google, "x", fake(503, {}))).toMatchObject({ ok: false, reason: "unavailable" });
});

test("a provider's refusal comes back with the key it was sent masked, also where the message is cut", async () => {
  const key = "sk-or-v1-" + "0123456789abcdef".repeat(4);
  const endpoint = endpointFor("openrouter", key, { openRouterUrl: "https://or" });
  const refusing = (status: number, message: string): typeof fetch => async () => new Response(JSON.stringify({ error: { message } }), { status });
  expect(await checkModelCall(endpoint, "x", refusing(401, `${"a".repeat(180)}${key}${"b".repeat(100)}`))).toEqual({ ok: false, reason: "key", detail: `${"a".repeat(180)}•••${"b".repeat(17)}` });
  expect(await checkModelCall(endpoint, "x", refusing(404, `No endpoints found for x with the key ${key}.`))).toEqual({ ok: false, reason: "model", detail: "No endpoints found for x with the key •••." });
});
