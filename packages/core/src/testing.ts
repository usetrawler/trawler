import { APICallError } from "ai";
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

export function proxyRefusal(message: string, type: string | null = null) {
  return new APICallError({ message, url: "https://cp.test/api/llm/v1/chat/completions", requestBodyValues: {}, statusCode: 402, data: { error: { code: 402, message, type } } });
}

type Part = ReturnType<typeof toolCall> | ReturnType<typeof text>;

export function scriptedModel(responses: Array<Part | Part[] | Error>, costPerStep = 0.001) {
  let callNo = 0;
  const results = responses.map((response) => {
    if (response instanceof Error) return response;
    const parts = Array.isArray(response) ? response : [response];
    return {
      content: parts.map((part) => (part.type === "tool-call" ? { ...part, toolCallId: `call-${++callNo}` } : part)),
      finishReason: { unified: parts.some((p) => p.type === "tool-call") ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
      usage,
      providerMetadata: { openrouter: { usage: { cost: costPerStep } } },
      warnings: [],
    };
  });
  let next = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const result = results[next++];
      if (!result) throw new Error(`scriptedModel has only ${results.length} responses; call ${next} has none`);
      if (result instanceof Error) throw result;
      return result;
    },
  });
}
