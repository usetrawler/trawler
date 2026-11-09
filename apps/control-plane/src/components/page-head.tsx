import type { ReactNode } from "react";
import { primaryButton } from "./controls.ts";

export const pageTitle = "text-2xl leading-tight font-semibold tracking-tight wrap-anywhere md:text-[28px]";

export function PageHead({ eyebrow, title, subtitle, action, flush = false, children }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; action?: ReactNode; flush?: boolean; children?: ReactNode }) {
  return (
    <div className={flush ? "" : "mb-10"}>
      {eyebrow && <div className="mb-1 text-sm wrap-anywhere text-muted">{eyebrow}</div>}
      <div className="flex flex-col items-start gap-4 md:min-h-10 md:flex-row md:justify-between md:gap-6">
        <h1 className={`min-w-0 ${pageTitle}`}>{title}</h1>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-3">{action}</div>}
      </div>
      {subtitle && <div className="mt-2 text-muted">{subtitle}</div>}
      {children}
    </div>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} className={primaryButton}>{children}</a>;
}
