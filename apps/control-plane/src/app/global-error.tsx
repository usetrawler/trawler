"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body className="min-h-dvh bg-paper font-sans text-ink antialiased">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4">
          <h1 className="text-3xl font-bold tracking-tight">Something went wrong.</h1>
          <p className="text-muted">We have been told about it. Try again, or come back in a minute.</p>
          <button
            type="button"
            onClick={reset}
            className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110"
          >
            Try again <span aria-hidden="true">→</span>
          </button>
        </main>
      </body>
    </html>
  );
}
