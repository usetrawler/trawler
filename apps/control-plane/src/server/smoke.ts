import type { SmokeDeps } from "../smoke/smoke.ts";
import { getDb, getKeyring } from "./db.ts";
import { DEFAULT_SETUP_MODEL, readEnv } from "./env.ts";

export function smokeDeps(): SmokeDeps {
  const env = readEnv();
  return { db: getDb(), keys: getKeyring(), smokeToken: env.smokeToken, modelKey: env.setup?.apiKey, model: env.setup?.model ?? DEFAULT_SETUP_MODEL };
}
