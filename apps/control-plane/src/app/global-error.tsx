"use client";

import { pageTitle } from "../components/page-head.tsx";
import * as Sentry from "@sentry/nextjs";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useEffect } from "react";
import { ThemeScript } from "../components/theme-toggle.tsx";
import { UPDATED_SINCE_OPENED } from "../components/updated-since-opened.ts";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const updated = unstable_isUnrecognizedActionError(error);
  useEffect(() => {
    if (!error.digest && !updated) Sentry.captureException(error);
  }, [error, updated]);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>{updated ? "Page updated · Trawler" : "Something went wrong · Trawler"}</title>
        <ThemeScript />
      </head>
      <body className="min-h-dvh bg-paper font-sans text-ink antialiased">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4">
          <h1 className={pageTitle}>{updated ? UPDATED_SINCE_OPENED : "Something went wrong."}</h1>
          <p className="text-muted">{updated ? "Reload the page to carry on." : "Try again, or come back in a minute."}</p>
          <button
            type="button"
            onClick={updated ? () => window.location.reload() : reset}
            className="flex h-10 items-center justify-center gap-2 rounded-md bg-action px-4 text-sm font-medium text-[#171717] transition-[filter] hover:brightness-105"
          >
            {updated ? "Reload the page" : "Try again"} <span aria-hidden="true">→</span>
          </button>
        </main>
      </body>
    </html>
  );
}
