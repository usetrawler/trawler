"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createModel, MAX_CHOSEN_FEATURES, MAX_DESCRIPTION_CHARS, MAX_FEATURE_CHARS, SetupModelFailed, SIGN_UP, type ProductSummary, type SignUp } from "@usetrawler/core/setup";
import { signedInMember } from "../../server/auth.ts";
import { getDb, getKeyring } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";
import { logError, writeLog } from "../../server/log.ts";
import { FetchRefused, safeFetchText, type RefusalReason } from "../../setup/safe-fetch.ts";
import { describeDraft, DraftGone, proposeFromDraft, SetupLimited, SetupStillRunning, setupProgress, startDraft, type SetupDeps } from "../../setup/propose.ts";
import type { SetupProgress } from "../../setup/progress.ts";
import { ProjectNotFound } from "../../projects/projects.ts";
import { ProjectLimitReached } from "../../runs/plans.ts";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalise(raw: string): string {
  const trimmed = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const MESSAGES: Record<RefusalReason, string> = {
  address: "Enter a web address such as https://app.example.com.",
  too_long: "That address is too long.",
  private: "That address is on a private network. Trawler can only read public pages from here.",
  unresolved: "We could not find that address. Check the spelling.",
  timeout: "The page took too long to answer.",
  status: "The page answered with an error.",
  redirects: "The page redirected too many times.",
};

function friendly(err: unknown): string {
  if (err instanceof FetchRefused) return err.reason === "status" ? `The page answered with an error (${err.message}).` : MESSAGES[err.reason];
  if (err instanceof SetupLimited) return "You have started many new projects recently. Try again in a few minutes.";
  if (err instanceof SetupModelFailed) return "Trawler's setup model could not write a plan this time. Try again in a moment.";
  if (err instanceof DraftGone) return "This setup has expired. Start again from the product's address.";
  if (err instanceof SetupStillRunning) return "Trawler is still choosing the people for this setup. Wait a moment.";
  if (err instanceof ProjectNotFound) return "This project is gone.";
  if (err instanceof ProjectLimitReached) return err.message;
  return "We could not build a plan for this page. Try again in a moment.";
}

async function setupFor(): Promise<{ orgId: string; deps: SetupDeps } | { error: string }> {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const env = readEnv();
  const setup = env.setup;
  if (!setup) return { error: "Setup is not configured on this server." };
  const model = createModel({ modelId: setup.model, apiKey: setup.apiKey, baseURL: env.openRouterUrl });
  return { orgId: member.orgId, deps: { db: getDb(), keys: getKeyring(), model, modelId: setup.model, fetchText: (u: string) => safeFetchText(u) } };
}

async function failed(err: unknown, orgId: string, what: string): Promise<{ ok: false; error: string }> {
  if (err instanceof FetchRefused) await writeLog("info", "setup refused the address", { orgId, reason: err.reason });
  else if (err instanceof SetupLimited) await writeLog("info", "setup is rate limited", { orgId });
  else if (!(err instanceof DraftGone) && !(err instanceof ProjectNotFound) && !(err instanceof ProjectLimitReached) && !(err instanceof SetupStillRunning)) await logError(what, { orgId, err });
  return { ok: false, error: friendly(err) };
}

export async function readProductAction(input: { url?: string; projectId?: string }): Promise<Result<{ draftId: string }>> {
  const url = typeof input.url === "string" ? input.url : "";
  const projectId = typeof input.projectId === "string" && UUID.test(input.projectId) ? input.projectId : undefined;
  if (!projectId && !url.trim()) return { ok: false, error: "Paste the address of the product to test." };
  if (url.length > 2048) return { ok: false, error: MESSAGES.too_long };
  const setup = await setupFor();
  if ("error" in setup) return { ok: false, error: setup.error };
  try {
    return { ok: true, draftId: await startDraft(setup.deps, { orgId: setup.orgId, ...(projectId ? { projectId } : { url: normalise(url) }) }) };
  } catch (err) {
    return failed(err, setup.orgId, "setup could not read the page");
  }
}

export async function describeProductAction(draftId: string): Promise<Result<{ summary: ProductSummary }>> {
  if (typeof draftId !== "string" || !UUID.test(draftId)) return { ok: false, error: friendly(new DraftGone()) };
  const setup = await setupFor();
  if ("error" in setup) return { ok: false, error: setup.error };
  try {
    return { ok: true, summary: await describeDraft(setup.deps, { orgId: setup.orgId, draftId }) };
  } catch (err) {
    return failed(err, setup.orgId, "setup could not describe the product");
  }
}

const Chosen = z.object({
  draftId: z.string().regex(UUID),
  description: z.string().trim().max(MAX_DESCRIPTION_CHARS),
  features: z.array(z.string().trim().max(MAX_FEATURE_CHARS)).max(MAX_CHOSEN_FEATURES).transform((list) => list.filter(Boolean)),
  signUp: z.enum(SIGN_UP).default("unclear"),
});

export async function proposePeopleAction(input: { draftId: string; description: string; features: string[]; signUp?: SignUp }): Promise<Result> {
  const chosen = Chosen.safeParse(input);
  if (!chosen.success) return { ok: false, error: `Keep the description under ${MAX_DESCRIPTION_CHARS.toLocaleString("en-GB")} characters and choose at most ${MAX_CHOSEN_FEATURES} features.` };
  if (chosen.data.features.length === 0) return { ok: false, error: "Choose at least one feature for the people to try." };
  const setup = await setupFor();
  if ("error" in setup) return { ok: false, error: setup.error };
  let projectId: string;
  try {
    projectId = await proposeFromDraft(setup.deps, { orgId: setup.orgId, ...chosen.data });
  } catch (err) {
    return failed(err, setup.orgId, "setup could not propose people");
  }
  redirect(`/projects/${projectId}`);
}

export async function setupProgressAction(draftId: string): Promise<SetupProgress> {
  if (typeof draftId !== "string" || !UUID.test(draftId)) return { state: "gone" };
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  return setupProgress({ db: getDb() }, { orgId: member.orgId, draftId });
}
