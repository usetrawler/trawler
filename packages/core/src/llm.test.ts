import { generateText, streamText } from "ai";
import { expect, test } from "vitest";
import { Budget, createModel, stepCost } from "./llm.ts";
import { scriptedModel, text, toolCall } from "./testing.ts";

test("stepCost reads OpenRouter usage accounting", () => {
  expect(stepCost({ providerMetadata: { openrouter: { usage: { cost: 0.0012 } } } })).toBeCloseTo(0.0012);
});

test("stepCost is zero when the provider reports nothing", () => {
  expect(stepCost({})).toBe(0);
  expect(stepCost({ providerMetadata: { openrouter: { usage: {} } } })).toBe(0);
  expect(stepCost({ providerMetadata: { openrouter: { usage: { cost: "0.5" } } } })).toBe(0);
});

test("stepCost adds the upstream provider cost for BYOK requests", () => {
  expect(stepCost({ providerMetadata: { openrouter: { usage: { cost: 0.95, costDetails: { upstreamInferenceCost: 19 } } } } })).toBeCloseTo(19.95);
  expect(stepCost({ providerMetadata: { openrouter: { usage: { cost: 0, costDetails: { upstreamInferenceCost: 0.02 } } } } })).toBeCloseTo(0.02);
});

test("stepCost does not double-count when upstream cost equals the charge", () => {
  expect(stepCost({ providerMetadata: { openrouter: { usage: { cost: 0.0001102, costDetails: { upstreamInferenceCost: 0.0001102 } } } } })).toBeCloseTo(0.0001102);
});

test("stepCost ignores negative and non-finite values", () => {
  expect(stepCost({ providerMetadata: { openrouter: { usage: { cost: Number.NaN } } } })).toBe(0);
  expect(stepCost({ providerMetadata: { openrouter: { usage: { cost: -1 } } } })).toBe(0);
});

test("budget refuses costs that would disable it", () => {
  const b = new Budget(1);
  expect(() => b.add(Number.NaN)).toThrow(RangeError);
  expect(() => b.add(-10)).toThrow(RangeError);
  expect(b.spent).toBe(0);
});

test("budget refuses a limit that is not a positive number", () => {
  expect(() => new Budget(0)).toThrow(RangeError);
  expect(() => new Budget(Number.NaN)).toThrow(RangeError);
});

test("budget treats float sums that land a hair under the limit as reached", () => {
  const b = new Budget(1);
  for (let i = 0; i < 10; i++) b.add(0.1);
  expect(b.spent).toBeLessThan(1);
  expect(b.exceeded).toBe(true);
});

test("budget trips once spend reaches the limit", () => {
  const b = new Budget(1);
  b.add(0.6);
  expect(b.exceeded).toBe(false);
  b.add(0.4);
  expect(b.exceeded).toBe(true);
  expect(b.spent).toBeCloseTo(1);
});

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const bodies: Record<string, unknown>[] = [];

async function fakeOpenRouter(url: RequestInfo | URL, init?: RequestInit) {
  const body = JSON.parse(String(init?.body));
  calls.push({ url: String(url), body });
  bodies.push(body);
  if (body.stream) {
    const sse = [
      { id: "gen-1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
      { id: "gen-1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.00002 } },
    ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(
    JSON.stringify({
      id: "gen-1",
      model: "deepseek/deepseek-v4.1-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.00002 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("createModel keeps data_collection deny when a call passes its own provider options", async () => {
  calls.length = 0;
  const model = createModel({ modelId: "m", apiKey: "k", fetch: fakeOpenRouter });
  await generateText({ model, prompt: "hello", providerOptions: { openrouter: { provider: { order: ["deepinfra"] } } } });
  expect(calls[0]!.body).toMatchObject({ provider: { order: ["deepinfra"], data_collection: "deny" }, usage: { include: true } });
});

test("createModel talks to a custom base URL such as our proxy", async () => {
  calls.length = 0;
  const model = createModel({ modelId: "m", apiKey: "k", baseURL: "https://proxy.local/llm/v1/", fetch: fakeOpenRouter });
  await generateText({ model, prompt: "hello" });
  expect(calls[0]!.url).toBe("https://proxy.local/llm/v1/chat/completions");
});

test("createModel asks for usage in streamed responses and reads their cost", async () => {
  calls.length = 0;
  const model = createModel({ modelId: "m", apiKey: "k", fetch: fakeOpenRouter });
  const result = streamText({ model, prompt: "hello" });
  await result.consumeStream();
  expect(calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  expect(stepCost((await result.steps)[0]!)).toBeCloseTo(0.00002);
});

test("createModel sends usage accounting and data_collection deny to OpenRouter", async () => {
  bodies.length = 0;
  const model = createModel({ modelId: "deepseek/deepseek-v4.1-flash", apiKey: "k", fetch: fakeOpenRouter });
  const result = await generateText({ model, prompt: "hello" });
  expect(bodies[0]).toMatchObject({ model: "deepseek/deepseek-v4.1-flash", usage: { include: true }, provider: { data_collection: "deny" } });
  expect(stepCost(result.steps[0]!)).toBeCloseTo(0.00002);
});

test("scriptedModel plays one response per step and reports the configured cost", async () => {
  const model = scriptedModel([toolCall("echo", { v: 1 }), text("done")], 0.25);
  const r1 = await generateText({ model, prompt: "a" });
  expect(r1.toolCalls[0]?.toolName).toBe("echo");
  expect(stepCost(r1.steps[0]!)).toBe(0.25);
  const r2 = await generateText({ model, prompt: "b" });
  expect(r2.text).toBe("done");
  expect(model.doGenerateCalls).toHaveLength(2);
});

test("scriptedModel fails loudly once its script is exhausted", async () => {
  const model = scriptedModel([text("only")]);
  await generateText({ model, prompt: "a" });
  await expect(generateText({ model, prompt: "b" })).rejects.toThrow(/only 1 responses; call 2 has none/);
});
