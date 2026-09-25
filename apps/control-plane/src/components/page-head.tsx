import type { ReactNode } from "react";

export function PageHead({ eyebrow, title, subtitle, action }: { eyebrow: ReactNode; title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
      <div className="min-w-0 self-stretch md:self-auto">
        <p className="mt-[11px] font-mono text-[11px] leading-[normal] tracking-[0.1em] wrap-anywhere text-action uppercase">{eyebrow}</p>
        <h1 className="my-2.5 text-[44px] leading-[0.96] font-bold tracking-[-0.055em] wrap-anywhere md:text-[clamp(44px,5vw,72px)]">{title}</h1>
        {subtitle && <p className="text-base leading-[normal] text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="flex h-[50px] shrink-0 items-center gap-[38px] bg-action px-[18px] font-mono text-xs text-[#17191c] uppercase hover:brightness-110">
      {children}
      <span aria-hidden>→</span>
    </a>
  );
}
