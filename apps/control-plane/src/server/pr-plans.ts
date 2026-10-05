import { createModel } from "@usetrawler/core/setup";
import { planDueRuns, type PrPlanDeps } from "../runs/pr-plan.ts";
import { safeFetchText } from "../setup/safe-fetch.ts";
import { getDb } from "./db.ts";
import { readEnv } from "./env.ts";
import { logError } from "./log.ts";

const SWEEP_MS = 15_000;
const PAGE_TIMEOUT_MS = 5_000;

function prPlanDeps(): PrPlanDeps {
  const env = readEnv();
  const setup = env.setup;
  return {
    db: getDb(),
    model: setup ? createModel({ modelId: setup.model, apiKey: setup.apiKey, baseURL: env.openRouterUrl }) : null,
    modelId: setup?.model ?? "",
    fetchText: async (url) => (await safeFetchText(url, { timeoutMs: PAGE_TIMEOUT_MS })).text,
  };
}

let planning = false;

export function kickPrPlans(): void {
  if (planning) return;
  planning = true;
  void Promise.resolve()
    .then(() => planDueRuns(prPlanDeps()))
    .catch((err: unknown) => logError("pull request plans could not be made", { err }))
    .finally(() => {
      planning = false;
    });
}

export function startPrPlanSweep(): () => void {
  const every = setInterval(kickPrPlans, SWEEP_MS);
  every.unref();
  return () => clearInterval(every);
}
