import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export function createModel(opts: { modelId: string; apiKey: string; baseURL?: string; fetch?: typeof globalThis.fetch }) {
  const provider = createOpenRouter({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: opts.fetch });
  return provider(opts.modelId, { usage: { include: true }, provider: { data_collection: "deny" } });
}

export function stepCost(step: { providerMetadata?: Record<string, unknown> }): number {
  const usage = (step.providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage;
  return typeof usage?.cost === "number" ? usage.cost : 0;
}

export class Budget {
  #spent = 0;
  constructor(readonly limitUsd: number) {}
  add(usd: number): void {
    this.#spent += usd;
  }
  get spent(): number {
    return this.#spent;
  }
  get exceeded(): boolean {
    return this.#spent >= this.limitUsd - 1e-9;
  }
}
