"use client";
import { useState } from "react";
import { authClient } from "../../auth-client.ts";
import { field } from "../../../components/key-fields.tsx";

export interface ConsentFormProps {
  query: string;
  requestedScopes: string[];
  account: { name: string; email: string };
  workspace: string;
  controlOffered: boolean;
  controlNote: string | null;
  projects: Array<{ id: string; name: string }>;
}

const RUN_CONTROL = "trawler:runs:write";
const choice = "flex items-start gap-3 border border-line p-3 text-sm has-[:checked]:border-ink";
const link = "inline-block py-2 underline underline-offset-4 hover:text-ink";

export function ConsentForm({ query, requestedScopes, account, workspace, controlOffered, controlNote, projects }: ConsentFormProps) {
  const [access, setAccess] = useState<"read" | "control">("read");
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const scope = requestedScopes.filter((s) => s !== RUN_CONTROL || access === "control").join(" ");
  const busy = state !== "idle";
  const decide = async (accept: boolean) => {
    if (busy) return;
    setState("working");
    setError(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: query, ...(accept ? { scope, ...(projectId ? { project_id: projectId } : {}) } : {}) }),
      });
      const result = await response.json() as { url?: string; redirect_uri?: string };
      const url = result.url ?? result.redirect_uri;
      if (!response.ok || !url) throw new Error("consent_failed");
      setState("done");
      window.location.assign(url);
    } catch {
      setError(accept ? "Connecting did not work. Try again, or start the connection again from your assistant." : "Cancelling did not work. You can close this tab; the assistant will give up by itself.");
      setState("idle");
    }
  };
  const switchAccount = async () => {
    if (busy) return;
    setState("working");
    setError(null);
    const result = await authClient.signOut().catch(() => ({ error: true }));
    if (result && "error" in result && result.error) {
      setError("Signing out did not work. Try again.");
      setState("idle");
      return;
    }
    window.location.assign(`/sign-in${window.location.search}`);
  };
  return <>
    <p className="text-sm">
      Signed in as <strong className="wrap-anywhere">{account.name}</strong> <span className="wrap-anywhere text-muted">({account.email})</span>.{" "}
      <button type="button" onClick={switchAccount} aria-disabled={busy || undefined} className={link}>Not you? Switch account</button>
    </p>
    <p className="text-sm">
      This connection will act in <strong className="wrap-anywhere">{workspace}</strong>, and stays there when you switch workspaces in Trawler. Wrong workspace? Cancel, switch it in Trawler, then connect again.
    </p>
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 font-mono text-xs tracking-[0.2em] text-muted uppercase">Access</legend>
      <label className={choice}>
        <input type="radio" name="access" value="read" checked={access === "read"} onChange={() => !busy && setAccess("read")} aria-labelledby="access-read" aria-describedby="access-read-help" className="mt-1" />
        <span><strong id="access-read">Read access</strong><span id="access-read-help" className="block text-muted">Read projects, plans, runs and their findings.</span></span>
      </label>
      {controlOffered && (
        <label className={choice}>
          <input type="radio" name="access" value="control" checked={access === "control"} onChange={() => !busy && setAccess("control")} aria-labelledby="access-control" aria-describedby="access-control-help" className="mt-1" />
          <span>
            <strong id="access-control">Read access and run control</strong>
            <span id="access-control-help" className="block text-muted">
              Also start and stop runs. A run spends this workspace&apos;s budget and visits your project&apos;s target app. The assistant decides when to start one and may do so without asking you each time, so choose this only for an assistant you trust. The workspace&apos;s plan limits and budget still apply.
            </span>
          </span>
        </label>
      )}
      {controlNote && <p className="border-l-2 border-line pl-3 text-sm text-muted">{controlNote}</p>}
    </fieldset>
    {projects.length > 0 && (
      <label className="flex flex-col gap-2 text-sm">
        <span className="text-muted">Which projects it can reach. This limits reading and run control alike.</span>
        <select value={projectId} onChange={(e) => !busy && setProjectId(e.target.value)} className={field}>
          <option value="">All projects in {workspace}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>Only {p.name}</option>)}
        </select>
      </label>
    )}
    <p className="text-sm text-muted">
      Connecting an assistant does not give it permission to test a site you do not own or control.{" "}
      {requestedScopes.includes("offline_access")
        ? "It stays connected while it is in use; a connection nobody has used for 30 days stops working."
        : "It works for about 15 minutes, and then the assistant has to ask you again."}{" "}
      You can disconnect it any time under <a href="/settings" className="underline underline-offset-4 hover:text-ink">Settings, Your AI assistant connections</a>.
    </p>
    <div className="flex flex-wrap gap-3">
      <button type="button" aria-disabled={busy || undefined} onClick={() => decide(true)} className="min-h-12 border border-ink bg-ink px-5 py-3 font-medium text-paper aria-disabled:opacity-60">{access === "control" ? "Allow with run control" : "Allow read access"}</button>
      <button type="button" aria-disabled={busy || undefined} onClick={() => decide(false)} className="min-h-12 border border-line px-5 py-3 font-medium hover:border-ink aria-disabled:opacity-60">Cancel</button>
    </div>
    <p role="status" className="text-sm text-muted">{state === "working" ? "Working…" : state === "done" ? "Done. Return to your assistant; you can close this tab." : ""}</p>
    {error && <p role="alert" className="text-sm text-bad">{error}</p>}
  </>;
}
