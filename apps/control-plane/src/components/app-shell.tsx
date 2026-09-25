import type { ReactNode } from "react";
import { BrandMark } from "./brand-mark.tsx";
import { DocsLink } from "./docs-link.tsx";

const STEPS = ["Product", "Plan", "Run"] as const;

export function AppShell({ organization, email, step, children }: { organization: string; email: string; step?: 1 | 2 | 3; children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 md:px-8">
        <a href="/new" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <BrandMark />
          trawler
        </a>
        <div className="flex min-w-0 items-center gap-3 text-sm">
          <DocsLink className="-my-2 mr-3 shrink-0 py-2 font-mono text-xs tracking-[0.15em] text-muted uppercase hover:text-ink">Docs</DocsLink>
          <span className="hidden truncate text-muted sm:inline">{email}</span>
          <span className="truncate font-mono text-xs tracking-[0.15em] uppercase">{organization}</span>
        </div>
      </header>
      {step && (
        <nav aria-label="Progress" className="border-b border-line px-4 py-3 md:px-8">
          <ol className="flex gap-6 font-mono text-xs tracking-[0.15em] uppercase">
            {STEPS.map((label, i) => (
              <li key={label} aria-current={i + 1 === step ? "step" : undefined} className={i + 1 === step ? "text-action" : i + 1 < step ? "text-ink" : "text-muted"}>
                {String(i + 1).padStart(2, "0")} {label}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <main className="mx-auto w-full max-w-3xl px-4 py-10 md:py-16">{children}</main>
    </div>
  );
}
