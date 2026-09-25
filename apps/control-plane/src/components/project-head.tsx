import { hostOf } from "../projects/overview.ts";
import { PageHead, PrimaryLink } from "./page-head.tsx";

export function ProjectHead({ project, address, tab, runs }: { project: { id: string; name: string; targetUrl: string }; address?: string; tab: "plan" | "runs"; runs: number }) {
  const tabs = [
    { key: "plan", href: `/projects/${project.id}`, label: "Plan" },
    { key: "runs", href: `/projects/${project.id}/runs`, label: "Runs", count: runs },
  ] as const;
  return (
    <div className="mb-8">
      <PageHead
        eyebrow={<>Project · <a href={project.targetUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">{address ?? hostOf(project.targetUrl)}<span aria-hidden> ↗</span><span className="sr-only normal-case"> (opens in a new tab)</span></a></>}
        title={project.name}
        action={<PrimaryLink href={`/projects/${project.id}#start`}>New run</PrimaryLink>}
      />
      <nav aria-label="Project">
        <ul className="-mt-4 flex gap-6 border-b border-line">
          {tabs.map((t) => (
            <li key={t.key}>
              <a
                href={t.href}
                aria-current={tab === t.key ? "page" : undefined}
                className={`-mb-px flex items-center gap-2 border-b-2 pt-1 pb-3 ${tab === t.key ? "border-action font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                {t.label}
                {"count" in t && <span className="border border-line px-1.5 py-0.5 font-mono text-[10px] font-normal">{t.count}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
