import type { Price } from "../llm/prices.ts";

export const TOKEN_PROFILE = { step: { input: 13_500, output: 200 }, judge: { input: 6_000, output: 150 } };
export const STEPS = { base: 10, perGoal: 20, typicalPerGoal: 12, typicalReplay: 15 };
export const DEFAULT_RUN = { maxSteps: 120, replaySteps: 30, budgetUsd: 2, tokenCap: 3_000_000 };

export const turnSteps = (goals: number, ceiling: number = DEFAULT_RUN.maxSteps) => Math.min(ceiling, STEPS.base + STEPS.perGoal * Math.max(1, goals));

const usd = (p: Price, tokens: { input: number; output: number }) => (tokens.input * p.promptUsdPerMtok + tokens.output * p.completionUsdPerMtok) / 1_000_000;

export function estimateUsd(price: Price, goalsPerTurn: number[], highPrice: Price = price): { low: number; high: number; perDefect: number } {
  const typical = goalsPerTurn.reduce((n, goals) => n + Math.min(turnSteps(goals), STEPS.typicalPerGoal * Math.max(1, goals)), 0);
  const most = goalsPerTurn.reduce((n, goals) => n + turnSteps(goals), 0);
  const perDefect = usd(highPrice, TOKEN_PROFILE.step) * STEPS.typicalReplay + usd(highPrice, TOKEN_PROFILE.judge);
  return { low: usd(price, TOKEN_PROFILE.step) * typical, high: usd(highPrice, TOKEN_PROFILE.step) * most, perDefect };
}
