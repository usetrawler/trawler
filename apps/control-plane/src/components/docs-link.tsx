import type { ReactNode } from "react";

const SITE_URL = "https://usetrawler.com/";

export function DocsLink({ className, children, page = "docs/" }: { className?: string; children: ReactNode; page?: `docs/${string}` | "terms/" | "privacy/" }) {
  return (
    <a href={SITE_URL + page} target="_blank" rel="noreferrer" className={className}>
      {children}
      <span aria-hidden> ↗</span>
      <span className="sr-only normal-case"> (opens in a new tab)</span>
    </a>
  );
}
