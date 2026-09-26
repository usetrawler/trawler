"use client";

import * as Sentry from "@sentry/nextjs";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useEffect } from "react";
import { ThemeScript } from "../components/theme-toggle.tsx";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const updated = unstable_isUnrecognizedActionError(error);
  useEffect(() => {
    if (!error.digest && !updated) Sentry.captureException(error);
  }, [error, updated]);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-dvh bg-paper font-sans text-ink antialiased">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4">
          <h1 className="text-3xl font-bold tracking-tight">{updated ? "Trawler was updated since this page opened." : "Something went wrong."}</h1>
          <p className="text-muted">{updated ? "Reload the page to carry on." : "Try again, or come back in a minute."}</p>
          <button
            type="button"
            onClick={updated ? () => window.location.reload() : reset}
            className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110"
          >
            {updated ? "Reload the page" : "Try again"} <span aria-hidden="true">→</span>
          </button>
        </main>
      </body>
    </html>
  );
}
