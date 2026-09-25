export interface RunModel {
  id: string;
  label: string;
  note?: string;
  usdPerStep: number;
}

export const RUN_MODELS: RunModel[] = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", note: "Recommended", usdPerStep: 0.0016 },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", usdPerStep: 0.006 },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", note: "Higher quality", usdPerStep: 0.01 },
];

export const DEFAULT_RUN = { maxSteps: 60, replaySteps: 30, budgetUsd: 2 };

export function estimateUsd(model: RunModel, personas: number): { low: number; high: number; perDefect: number } {
  const role = model.usdPerStep * DEFAULT_RUN.maxSteps;
  const perDefect = model.usdPerStep * DEFAULT_RUN.replaySteps * 0.6 + model.usdPerStep;
  return { low: personas * role * 0.5, high: personas * role, perDefect };
}
