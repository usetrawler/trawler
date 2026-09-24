import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

export function toolCall(name: string, input: unknown) {
  return { type: "tool-call" as const, toolName: name, input: JSON.stringify(input) };
}

export function text(t: string) {
  return { type: "text" as const, text: t };
}

export function scriptedModel(responses: Array<ReturnType<typeof toolCall> | ReturnType<typeof text>>, costPerStep = 0.001) {
  const results = responses.map((part, i) => ({
    content: [part.type === "tool-call" ? { ...part, toolCallId: `call-${i + 1}` } : part],
    finishReason: { unified: part.type === "tool-call" ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
    usage,
    providerMetadata: { openrouter: { usage: { cost: costPerStep } } },
    warnings: [],
  }));
  let next = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const result = results[next++];
      if (!result) throw new Error(`scriptedModel has only ${results.length} responses; call ${next} has none`);
      return result;
    },
  });
}
