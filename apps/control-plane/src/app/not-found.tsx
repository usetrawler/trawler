import type { Metadata } from "next";
import { BrandMark } from "../components/brand-mark.tsx";
import { primaryButton } from "../components/controls.ts";
import { pageTitle } from "../components/page-head.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { RequestedPath } from "./requested-path.tsx";

const TITLE = "Page not found · Trawler";

export const metadata: Metadata = { title: { absolute: TITLE } };

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <title>{TITLE}</title>
      <header className="flex items-center justify-between gap-4 px-4 py-4 md:px-8">
        <a href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <BrandMark className="size-6" />
          trawler
        </a>
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-4 pb-24">
        <p className="text-sm text-muted">Error 404</p>
        <h1 className={pageTitle}>This page does not exist.</h1>
        <p className="text-muted">The address may be wrong, or the page may have moved.</p>
        <RequestedPath />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <a href="/" className={primaryButton}>Open Trawler</a>
          <a href="https://usetrawler.com/" className="text-sm underline underline-offset-4 hover:text-muted">usetrawler.com</a>
        </div>
        <p className="text-sm text-muted">A link brought you here? <a href="mailto:contact@usetrawler.com" className="underline underline-offset-4 hover:text-ink">Report a broken link</a></p>
      </main>
    </div>
  );
}
