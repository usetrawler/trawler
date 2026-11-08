import type { ReactNode } from "react";

export function PageHead({ eyebrow, title, subtitle, action, compact = false }: { eyebrow: ReactNode; title: ReactNode; subtitle?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className="mb-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
      <div className="min-w-0 self-stretch md:self-auto">
        <p className="text-sm wrap-anywhere text-muted">{eyebrow}</p>
        <h1 className={`mt-1 font-semibold tracking-tight wrap-anywhere ${compact ? "text-2xl leading-tight md:text-[28px]" : "text-3xl leading-tight md:text-4xl"}`}>{title}</h1>
        {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="flex h-10 shrink-0 items-center gap-2 rounded-md bg-action px-4 text-sm font-medium text-[#171717] transition-[filter] hover:brightness-105">
      {children}
    </a>
  );
}
