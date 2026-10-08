"use client";
import { useState } from "react";
import { authClient } from "../../auth-client.ts";

const link = "inline-block py-2 underline underline-offset-4 hover:text-ink disabled:opacity-60";

export function ConsentEscape({ query, signedIn = true }: { query?: string; signedIn?: boolean }) {
  const [state, setState] = useState<"idle" | "working" | "cancelled">("idle");
  const [error, setError] = useState<string | null>(null);
  const switchAccount = async () => {
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
  const cancel = async () => {
    setState("working");
    setError(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept: false, oauth_query: query }) });
      const result = await response.json() as { url?: string; redirect_uri?: string };
      const url = result.url ?? result.redirect_uri;
      if (!response.ok || !url) throw new Error("cancel_failed");
      setState("cancelled");
      window.location.assign(url);
    } catch {
      setError("Cancelling did not work. You can close this tab; the assistant will give up by itself.");
      setState("idle");
    }
  };
  const busy = state === "working";
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-x-5">
        {signedIn && <button type="button" onClick={switchAccount} aria-disabled={busy || undefined} className={link}>Not you? Switch account</button>}
        {query && <button type="button" onClick={() => { if (!busy) void cancel(); }} aria-disabled={busy || undefined} className={link}>Cancel the connection</button>}
        <a href="/" className={link}>Go to Trawler</a>
      </div>
      <p role="status" className="text-muted">{state === "cancelled" ? "Cancelled. Return to your assistant; you can close this tab." : busy ? "Working…" : ""}</p>
      {error && <p role="alert" className="text-bad">{error}</p>}
    </div>
  );
}
