import type { RunnerApiDeps } from "../runner-api/handlers.ts";
import { getDb, getKeyring } from "./db.ts";
import { readEnv } from "./env.ts";

export function runnerApiDeps(): RunnerApiDeps | null {
  const runnerToken = readEnv().runnerToken;
  if (!runnerToken) return null;
  return { db: getDb(), keys: getKeyring(), runnerToken };
}

export const notConfigured = () => Response.json({ error: "runners are not configured on this server" }, { status: 503 });
