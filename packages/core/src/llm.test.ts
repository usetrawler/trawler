import { generateText } from "ai";
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

test("budget trips once spend reaches the limit", () => {
  const b = new Budget(1);
  b.add(0.6);
  expect(b.exceeded).toBe(false);
  b.add(0.4);
  expect(b.exceeded).toBe(true);
  expect(b.spent).toBeCloseTo(1);
});

test("createModel sends usage accounting and data_collection deny to OpenRouter", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: "gen-1",
        model: "deepseek/deepseek-v4.1-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.00002 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const model = createModel({ modelId: "deepseek/deepseek-v4.1-flash", apiKey: "k", fetch });
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
