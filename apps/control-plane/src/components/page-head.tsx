import type { ReactNode } from "react";
import { primaryButton } from "./controls.ts";

export const pageTitle = "text-2xl leading-tight font-semibold tracking-tight wrap-anywhere md:text-[28px]";

export function PageHead({ eyebrow, title, subtitle, action, flush = false }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; action?: ReactNode; flush?: boolean }) {
  return (
    <div className={`flex flex-col items-start justify-between gap-6 md:flex-row md:items-end ${flush ? "" : "mb-10"}`}>
      <div className="min-w-0 self-stretch md:self-auto">
        {eyebrow && <p className="mb-1 text-sm wrap-anywhere text-muted">{eyebrow}</p>}
        <h1 className={pageTitle}>{title}</h1>
        {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} className={primaryButton}>{children}</a>;
}
