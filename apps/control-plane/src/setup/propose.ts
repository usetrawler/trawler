import type { LanguageModel } from "ai";
import { Budget, proposeProject } from "@usetrawler/core";
import { sql } from "kysely";
import type { Database } from "../db/index.ts";
import { withOrg } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { FetchRefused } from "./safe-fetch.ts";

const SETUP_BUDGET_USD = 0.25;

export interface SetupDeps {
  db: Database;
  keys: Keyring;
  model: LanguageModel;
  modelId: string;
  fetchText: (url: string) => Promise<{ text: string; finalUrl: string }>;
}

export const SETUP_LIMITS = { perTenMinutes: 10, perDay: 100 };

export class SetupLimited extends Error {}

async function assertSetupAllowed(db: Database, orgId: string): Promise<void> {
  const counts = await withOrg(db, orgId, (tx) =>
    tx
      .selectFrom("projects")
      .select((eb) => [
        eb.fn.countAll<string>().filterWhere("created_at", ">", sql<Date>`now() - interval '10 minutes'`).as("recent"),
        eb.fn.countAll<string>().filterWhere("created_at", ">", sql<Date>`now() - interval '1 day'`).as("today"),
      ])
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow(),
  );
  if (Number(counts.recent) >= SETUP_LIMITS.perTenMinutes || Number(counts.today) >= SETUP_LIMITS.perDay) {
    throw new SetupLimited("too many new projects in a short time");
  }
}

export async function proposeFromUrl(deps: SetupDeps, input: { orgId: string; url: string; docsUrl?: string; focus?: string }): Promise<string> {
  await assertSetupAllowed(deps.db, input.orgId);
  const origins = new Set<string>();
  let refusal: FetchRefused | undefined;
  let project;
  try {
    ({ project } = await proposeProject({
      model: deps.model,
      modelId: deps.modelId,
      url: input.url,
      docsUrl: input.docsUrl,
      focus: input.focus,
      budget: new Budget(SETUP_BUDGET_USD),
      fetchText: async (url) => {
        try {
          const { text, finalUrl } = await deps.fetchText(url);
          origins.add(new URL(finalUrl).origin);
          return text;
        } catch (err) {
          if (err instanceof FetchRefused && url === input.url) refusal = err;
          throw err;
        }
      },
    }));
  } catch (err) {
    throw refusal ?? err;
  }
  const config = { ...project, allowedOrigins: [...new Set([...project.allowedOrigins, ...origins])] };
  return withOrg(deps.db, input.orgId, (tx) => createProject(tx, input.orgId, config, deps.keys, { focus: input.focus?.trim() || undefined }));
}
