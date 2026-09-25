import type { ReactNode } from "react";

const DOCS_URL = "https://usetrawler.com/docs/";

export function DocsLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <a href={DOCS_URL} target="_blank" rel="noreferrer" className={className}>
      {children}
      <span aria-hidden> ↗</span>
      <span className="sr-only normal-case"> (opens in a new tab)</span>
    </a>
  );
}
