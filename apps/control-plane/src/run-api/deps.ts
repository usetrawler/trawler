import { getDb, getKeyring } from "../server/db.ts";
import { readEnv } from "../server/env.ts";
import { kickPrPlans } from "../server/pr-plans.ts";
import type { RunApiDeps } from "./handlers.ts";

export function runApiDeps(): RunApiDeps {
  const env = readEnv();
  return { db: getDb(), keys: getKeyring(), baseUrl: env.baseURL, openRouterUrl: env.openRouterUrl, trawlerPays: !!env.setup, afterStart: kickPrPlans };
}
