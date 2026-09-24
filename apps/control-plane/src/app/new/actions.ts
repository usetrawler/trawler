"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createModel } from "@usetrawler/core";
import { getAuth } from "../../server/auth.ts";
import { getDb, getKeyring } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";
import { safeFetchText } from "../../setup/safe-fetch.ts";
import { proposeFromUrl } from "../../setup/propose.ts";

export interface SetupState {
  error?: string;
  url?: string;
  focus?: string;
}

function normalise(raw: string): string {
  const trimmed = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function friendly(message: string): string {
  if (/not allowed/.test(message)) return "That address is on a private network. Trawler can only read public pages from here.";
  if (/could not be resolved/.test(message)) return "We could not find that address. Check the spelling.";
  if (/timed out/.test(message)) return "The page took too long to answer.";
  if (/HTTP \d+/.test(message)) return `The page answered with an error (${/HTTP \d+/.exec(message)![0]}).`;
  if (/http\(s\)/.test(message)) return "Enter a web address such as https://app.example.com.";
  if (/budget|setup model/.test(message)) return "We could not build a plan for this page. Try again in a moment.";
  return "Something went wrong while reading the page. Try again.";
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
  const setup = readEnv().setup;
  if (!setup) return { error: "Setup is not configured on this server.", url, focus };
  let projectId: string;
  try {
    projectId = await proposeFromUrl(
      { db: getDb(), keys: getKeyring(), model: createModel({ modelId: setup.model, apiKey: setup.apiKey }), modelId: setup.model, fetchText: (u) => safeFetchText(u) },
      { orgId, url: normalise(url), focus },
    );
  } catch (err) {
    return { error: friendly(err instanceof Error ? err.message : String(err)), url, focus };
  }
  redirect(`/projects/${projectId}`);
}
