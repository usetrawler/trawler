import type { LanguageModel } from "ai";
import { Budget, proposeProject } from "@usetrawler/core";
import type { Database } from "../db/index.ts";
import { withOrg } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";

const SETUP_BUDGET_USD = 0.25;

export interface SetupDeps {
  db: Database;
  keys: Keyring;
  model: LanguageModel;
  modelId: string;
  fetchText: (url: string) => Promise<{ text: string; finalUrl: string }>;
}

export async function proposeFromUrl(deps: SetupDeps, input: { orgId: string; url: string; docsUrl?: string; focus?: string }): Promise<string> {
  const origins = new Set<string>();
  const { project } = await proposeProject({
    model: deps.model,
    modelId: deps.modelId,
    url: input.url,
    docsUrl: input.docsUrl,
    focus: input.focus,
    budget: new Budget(SETUP_BUDGET_USD),
    fetchText: async (url) => {
      const { text, finalUrl } = await deps.fetchText(url);
      origins.add(new URL(finalUrl).origin);
      return text;
    },
  });
  const config = { ...project, allowedOrigins: [...new Set([...project.allowedOrigins, ...origins])] };
  return withOrg(deps.db, input.orgId, (tx) => createProject(tx, input.orgId, config, deps.keys, { focus: input.focus?.trim() || undefined }));
}
