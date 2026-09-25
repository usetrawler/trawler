"use client";
import { useState } from "react";
import { authClient } from "../auth-client.ts";

const LABELS = { github: "Continue with GitHub", google: "Continue with Google", dev: "Continue with the development account" } as const;

export const signInWith = (provider: keyof typeof LABELS) => authClient.signIn.social({ provider, callbackURL: "/", errorCallbackURL: "/sign-in" });

export function SignInButtons({ providers }: { providers: Array<keyof typeof LABELS> }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (provider: keyof typeof LABELS) => {
    setPending(provider);
    setError(null);
    const result = await signInWith(provider);
    if (result.error) {
      setError(result.error.message ?? "Sign-in failed. Try again.");
      setPending(null);
    }
  };
  if (providers.length === 0) return <p className="text-bad">No sign-in method is configured on this server.</p>;
  return (
    <div className="flex flex-col gap-3">
      {providers.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => go(p)}
          disabled={pending !== null}
          className="flex min-h-12 items-center justify-between gap-3 border border-line bg-soft px-4 py-3 text-left font-medium transition hover:border-ink disabled:opacity-60"
        >
          <span>{LABELS[p]}</span>
          <span aria-hidden className="font-mono text-action">{pending === p ? "…" : "→"}</span>
        </button>
      ))}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </div>
  );
}
