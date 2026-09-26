import { expect, test, vi } from "vitest";
import { scrubberWith } from "../server/log.ts";
import { FetchRefused } from "../setup/safe-fetch.ts";
import { checkKey, checkModelCall, detectProvider, endpointFor, listModels, priceKey, PROVIDER_LABEL, PROVIDERS } from "./providers.ts";
import { providerArticle } from "./provider-kinds.ts";
import { parseOpenRouterPrices } from "./prices.ts";

vi.mock("../server/log.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/log.ts")>();
  return { ...real, scrubberWith: vi.fn(real.scrubberWith) };
});

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

const refusing = (status: number, message: string): typeof fetch => async () => new Response(JSON.stringify({ error: { message } }), { status });

test("a provider's refusal comes back with the key it was sent masked, also where the message is cut", async () => {
  const key = "sk-or-v1-" + "0123456789abcdef".repeat(4);
  const endpoint = endpointFor("openrouter", key, { openRouterUrl: "https://or" });
  expect(await checkModelCall(endpoint, "x", refusing(401, `${"a".repeat(180)}${key}${"b".repeat(100)}`))).toEqual({ ok: false, reason: "key", detail: `${"a".repeat(180)}•••${"b".repeat(17)}` });
  expect(await checkModelCall(endpoint, "x", refusing(401, `${key}${"a".repeat(177)}${key}${"b".repeat(50)}`))).toEqual({ ok: false, reason: "key", detail: `•••${"a".repeat(177)}•••${"b".repeat(17)}` });
  expect(await checkModelCall(endpoint, "x", refusing(404, `No endpoints found for x with the key ${key}.`))).toEqual({ ok: false, reason: "model", detail: "No endpoints found for x with the key •••." });
  expect(await checkModelCall(endpoint, "x", refusing(503, `Overloaded, retry with ${key} later.`))).toEqual({ ok: false, reason: "unavailable", detail: "Overloaded, retry with ••• later." });
});

test("a refusal longer than 4,000 characters is left out rather than searched for the key", async () => {
  const key = "k".repeat(20);
  const endpoint = endpointFor("custom", key, { openRouterUrl: "", customUrl: "https://llm.example.com/v1" });
  vi.mocked(scrubberWith).mockClear();
  expect(await checkModelCall(endpoint, "x", refusing(401, key.repeat(200)))).toEqual({ ok: false, reason: "key", detail: "•••" });
  expect(scrubberWith).toHaveBeenCalledTimes(1);
  vi.mocked(scrubberWith).mockClear();
  expect(await checkModelCall(endpoint, "x", refusing(401, `${key.repeat(200)}k`))).toEqual({ ok: false, reason: "key", detail: "" });
  expect(scrubberWith).not.toHaveBeenCalled();
});

test("a key to save is checked where a wrong one is refused: OpenRouter's key endpoint, the others' model listing", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const answer = (status: number): typeof fetch => async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? new Headers(init?.headers).get("x-api-key") });
    return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status });
  };
  const openRouter = endpointFor("openrouter", "sk-or-x", { openRouterUrl: "https://openrouter.test/api/v1" });
  expect(await checkKey(openRouter, answer(200))).toEqual({ ok: true, checked: true });
  expect(seen.at(-1)).toEqual({ url: "https://openrouter.test/api/v1/key", auth: "Bearer sk-or-x" });
  expect(await checkKey(openRouter, answer(401))).toEqual({ ok: false, reason: "key" });
  const anthropic = endpointFor("anthropic", "sk-ant-x", { openRouterUrl: "" });
  expect(await checkKey(anthropic, answer(200))).toEqual({ ok: true, checked: true });
  expect(seen.at(-1)).toEqual({ url: "https://api.anthropic.com/v1/models", auth: "sk-ant-x" });
  expect(await checkKey(anthropic, answer(403))).toEqual({ ok: false, reason: "key" });
  expect(await checkKey(anthropic, answer(404))).toEqual({ ok: false, reason: "unavailable" });
  expect(await checkKey(anthropic, answer(503))).toEqual({ ok: false, reason: "unavailable" });
});

test("an OpenAI-compatible service that lists no models is saved unchecked, and a private one is named as such", async () => {
  const custom = endpointFor("custom", "key-x", { openRouterUrl: "", customUrl: "https://llm.example.com/v1" });
  const answer = (status: number): typeof fetch => async () => new Response("{}", { status });
  expect(await checkKey(custom, answer(404))).toEqual({ ok: true, checked: false });
  expect(await checkKey(custom, answer(405))).toEqual({ ok: true, checked: false });
  expect(await checkKey(custom, answer(401))).toEqual({ ok: false, reason: "key" });
  expect(await checkKey(custom, async () => { throw new FetchRefused("private", "the address is not allowed"); })).toEqual({ ok: false, reason: "private" });
  expect(await checkKey(custom, async () => { throw new TypeError("fetch failed"); })).toEqual({ ok: false, reason: "unavailable" });
});
