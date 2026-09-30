import { DocsLink } from "./docs-link.tsx";

const link = "underline underline-offset-4 hover:text-ink";

export function LegalLinks({ lead }: { lead: string }) {
  return (
    <p className="text-sm text-muted">
      {lead} the <DocsLink page="terms/" className={link}>Terms</DocsLink> and the <DocsLink page="privacy/" className={link}>Privacy notice</DocsLink>.
    </p>
  );
}
