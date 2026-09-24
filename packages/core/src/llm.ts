import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

type OpenRouterOptions = { provider?: Record<string, unknown> } & Record<string, unknown>;

const denyDataCollection: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => {
    const openrouter = (params.providerOptions?.openrouter ?? {}) as OpenRouterOptions;
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        openrouter: { ...openrouter, provider: { ...openrouter.provider, data_collection: "deny" } },
      },
    };
  },
};

export function createModel(opts: { modelId: string; apiKey: string; baseURL?: string; fetch?: typeof globalThis.fetch }) {
  const provider = createOpenRouter({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: opts.fetch, compatibility: "strict" });
  return wrapLanguageModel({
    model: provider(opts.modelId, { usage: { include: true }, provider: { data_collection: "deny" } }),
    middleware: denyDataCollection,
  });
}

function finite(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

export function stepCost(step: { providerMetadata?: Record<string, unknown> }): number {
  const usage = (step.providerMetadata?.openrouter as { usage?: { cost?: unknown; costDetails?: { upstreamInferenceCost?: unknown } } } | undefined)?.usage;
  const charged = finite(usage?.cost);
  const upstream = finite(usage?.costDetails?.upstreamInferenceCost);
  return upstream > charged ? charged + upstream : charged;
}

export class Budget {
  #spent = 0;
  constructor(readonly limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new RangeError(`budget limit must be a positive number, got ${limitUsd}`);
  }
  add(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`cost must be a non-negative number, got ${usd}`);
    this.#spent += usd;
  }
  get spent(): number {
    return this.#spent;
  }
  get exceeded(): boolean {
    return this.#spent >= this.limitUsd - 1e-9;
  }
}
