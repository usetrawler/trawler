import type { Price } from "../llm/prices.ts";

export const TOKEN_PROFILE = { step: { input: 10_000, output: 300 }, judge: { input: 6_000, output: 150 } };
export const TYPICAL_ROLE_STEPS = 20;
export const DEFAULT_RUN = { maxSteps: 60, replaySteps: 30, budgetUsd: 2, tokenCap: 3_000_000 };

const usd = (p: Price, tokens: { input: number; output: number }) => (tokens.input * p.promptUsdPerMtok + tokens.output * p.completionUsdPerMtok) / 1_000_000;

export function estimateUsd(price: Price, personas: number): { low: number; high: number; perDefect: number } {
  const step = usd(price, TOKEN_PROFILE.step);
  const perDefect = step * TYPICAL_ROLE_STEPS * 0.75 + usd(price, TOKEN_PROFILE.judge);
  return { low: personas * step * TYPICAL_ROLE_STEPS, high: personas * step * DEFAULT_RUN.maxSteps, perDefect };
}
