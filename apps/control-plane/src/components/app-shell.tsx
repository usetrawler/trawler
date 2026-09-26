import type { ReactNode } from "react";
import type { Shell } from "../server/shell.ts";
import { BrandMark } from "./brand-mark.tsx";
import { DocsLink } from "./docs-link.tsx";
import { SignOutButton } from "./sign-out-button.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export type ShellPage = "overview" | "runs" | "new" | { project: string };

export function initials(text: string): string {
  const words = text.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean).map((word) => Array.from(word));
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? ["?"]).slice(0, 2).join("");
  return letters.toUpperCase();
}

const same = (current: ShellPage | undefined, page: ShellPage) =>
  typeof page === "string" ? current === page : typeof current === "object" && current.project === page.project;

function NavItem({ href, icon, label, detail, count, active, parent }: { href: string; icon: string; label: string; detail?: string | null; count?: number; active: boolean; parent: boolean }) {
  const title = detail ? `${label} · ${detail}` : label;
  return (
    <li className="shrink-0">
      <a
        href={href}
        aria-current={active ? (parent ? "true" : "page") : undefined}
        className={`flex h-[42px] items-center gap-2.5 px-[11px] -outline-offset-2 ${active ? "bg-paper text-ink shadow-[inset_2px_0_var(--action)]" : "text-muted hover:text-ink"}`}
      >
        <span aria-hidden className="w-[18px] shrink-0 text-action">{icon}</span>
        <span className="min-w-0" title={title}>
          <span className="block truncate">{label}</span>
          {detail && <span className="block truncate text-[10px] text-muted">{detail}</span>}
        </span>
        {count !== undefined && <span className="ml-auto border border-line px-1.5 py-0.5 font-mono text-[10px]">{count}</span>}
      </a>
    </li>
  );
}

function Account({ user }: { user: Shell["user"] }) {
  return (
    <section aria-label="Account" className="mt-4 hidden shrink-0 border border-line p-[13px] md:block">
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-ink font-mono text-[10px] text-paper">{initials(user.name || user.email)}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold" title={user.name || user.email}>{user.name || user.email}</p>
          {user.name && <p className="truncate text-xs text-muted" title={user.email}>{user.email}</p>}
        </div>
      </div>
      <SignOutButton className="mt-3 h-8 w-full border border-line bg-paper text-xs hover:border-ink" />
    </section>
  );
}

export function AppShell({ shell, current, parent = false, wide = false, children }: { shell: Shell; current?: ShellPage; parent?: boolean; wide?: boolean; children: ReactNode }) {
  const { user, workspace } = shell;
  const marked = (page: ShellPage) => same(current, page);
  return (
    <div className="app-frame min-h-dvh">
      <a href="#main" className="sr-only z-30 bg-paper focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:px-4 focus:py-3">Skip to content</a>
      <header className="flex h-16 items-center justify-between gap-4 border-b border-line bg-[var(--header)] px-4 backdrop-blur-md tall:sticky tall:top-0 tall:z-20 md:h-[76px] md:px-[clamp(20px,4.2vw,72px)]">
        <a href="/" className="flex shrink-0 items-center gap-2.5 text-[22px] font-bold tracking-tight">
          <BrandMark className="h-7 w-7" />
          <span className="max-[360px]:sr-only">trawler</span>
        </a>
        <div className="flex items-center gap-3">
          <DocsLink className="-my-2 shrink-0 py-2 font-mono text-xs tracking-[0.15em] text-muted uppercase hover:text-ink">Docs</DocsLink>
          <span className="sr-only md:hidden">Signed in as {user.name || user.email}</span>
          <span aria-hidden className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-ink font-mono text-[10px] text-paper max-[400px]:hidden md:hidden">{initials(user.name || user.email)}</span>
          <SignOutButton className="-my-2 shrink-0 py-2 font-mono text-xs tracking-[0.15em] text-muted uppercase hover:text-ink md:hidden" />
          <ThemeToggle />
        </div>
      </header>
      <div className="md:grid md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="border-b border-line bg-panel/80 md:flex md:flex-col md:border-r md:border-b-0 md:px-3.5 md:py-[22px] tall:sticky tall:top-[76px] tall:h-[calc(100dvh-76px)] tall:self-start">
          <div className="hidden h-[58px] shrink-0 grid-cols-[auto_1fr] items-center gap-2.5 border border-line bg-paper p-2.5 md:grid">
            <span aria-hidden className="grid h-[30px] w-[30px] place-items-center bg-action font-mono text-[9px] text-[#17191c]">{initials(workspace.name)}</span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-bold" title={workspace.name}>{workspace.name}</p>
              <p className="text-[10px] text-muted">{workspace.projects.length} {workspace.projects.length === 1 ? "project" : "projects"}</p>
            </div>
          </div>
          <nav aria-label="Workspace" className="flex gap-[3px] overflow-x-auto px-2 py-1 md:mt-[25px] md:block md:overflow-visible md:p-0 tall:min-h-0 tall:flex-1 tall:overflow-y-auto">
            <ul className="flex shrink-0 gap-[3px] md:flex-col">
              <NavItem href="/" icon="⌂" label="Overview" active={marked("overview")} parent={parent} />
              <NavItem href="/runs" icon="↗" label="All runs" count={workspace.runs} active={marked("runs")} parent={parent} />
            </ul>
            <p id="nav-projects" className="hidden px-[11px] pt-6 pb-2 font-mono text-[10px] tracking-[0.1em] text-muted uppercase md:block">Projects</p>
            <ul aria-labelledby="nav-projects" className="flex shrink-0 gap-[3px] md:flex-col">
              {workspace.projects.map((p) => <NavItem key={p.id} href={`/projects/${p.id}`} icon="◇" label={p.name} detail={p.address} active={marked({ project: p.id })} parent={parent} />)}
              <NavItem href="/new" icon="+" label="New project" active={marked("new")} parent={parent} />
            </ul>
          </nav>
          <Account user={user} />
        </div>
        <main id="main" className="min-w-0 px-[18px] py-9 md:px-[clamp(30px,5vw,78px)] md:py-[54px]">
          <div className={wide ? "w-full" : "mx-auto w-full max-w-3xl"}>{children}</div>
        </main>
      </div>
    </div>
  );
}
