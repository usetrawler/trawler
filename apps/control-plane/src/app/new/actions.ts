"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createModel } from "@usetrawler/core/setup";
import { getAuth } from "../../server/auth.ts";
import { getDb, getKeyring } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";
import { logError, writeLog } from "../../server/log.ts";
import { FetchRefused, safeFetchText, type RefusalReason } from "../../setup/safe-fetch.ts";
import { proposeFromUrl, SetupLimited } from "../../setup/propose.ts";

export interface SetupState {
  error?: string;
  url?: string;
  focus?: string;
}

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
  return "We could not build a plan for this page. Try again in a moment.";
}

export async function startSetup(_previous: SetupState, form: FormData): Promise<SetupState> {
  const url = String(form.get("url") ?? "");
  const focus = String(form.get("focus") ?? "").slice(0, 500);
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { error: "Your account has no workspace yet. Sign out and in again.", url, focus };
  if (!url.trim()) return { error: "Paste the address of the product to test.", url, focus };
  if (url.length > 2048) return { error: MESSAGES.too_long, url: url.slice(0, 2048), focus };
  const setup = readEnv().setup;
  if (!setup) return { error: "Setup is not configured on this server.", url, focus };
  let projectId: string;
  try {
    projectId = await proposeFromUrl(
      { db: getDb(), keys: getKeyring(), model: createModel({ modelId: setup.model, apiKey: setup.apiKey }), modelId: setup.model, fetchText: (u) => safeFetchText(u) },
      { orgId, url: normalise(url), focus },
    );
  } catch (err) {
    if (err instanceof FetchRefused) await writeLog("info", "setup refused the address", { orgId, reason: err.reason });
    else if (err instanceof SetupLimited) await writeLog("info", "setup is rate limited", { orgId });
    else await logError("setup failed", { orgId, err });
    return { error: friendly(err), url, focus };
  }
  redirect(`/projects/${projectId}`);
}
