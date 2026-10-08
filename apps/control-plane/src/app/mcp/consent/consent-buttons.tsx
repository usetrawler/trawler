"use client";
import { useState } from "react";

export function ConsentButtons({ query }: { query: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (accept: boolean) => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept, oauth_query: query }),
      });
      const result = await response.json() as { url?: string; redirect_uri?: string };
      const url = result.url ?? result.redirect_uri;
      if (!response.ok || !url) throw new Error("consent_failed");
      window.location.assign(url);
    } catch {
      setError("Connecting did not work. Start the connection again from your client.");
      setPending(false);
    }
  };
  return <>
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={pending} onClick={() => decide(true)} className="min-h-12 border border-ink bg-ink px-5 py-3 font-medium text-paper disabled:opacity-60">{pending ? "Connecting…" : "Allow connection"}</button>
      <button type="button" disabled={pending} onClick={() => decide(false)} className="min-h-12 border border-line px-5 py-3 font-medium hover:border-ink disabled:opacity-60">Cancel</button>
    </div>
    {error && <p role="alert" className="text-sm text-bad">{error}</p>}
  </>;
}
