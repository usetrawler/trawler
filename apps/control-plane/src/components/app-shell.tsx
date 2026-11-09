import type { ReactNode } from "react";
import type { Shell } from "../server/shell.ts";
import { BrandMark } from "./brand-mark.tsx";
import { RevealCurrentEntry } from "./current-entry.tsx";
import { DocsLink } from "./docs-link.tsx";
import { Icon, type IconName } from "./icon.tsx";
import { initials } from "./initials.ts";
import { Menu } from "./menu.tsx";
import { SignOutButton } from "./sign-out-button.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export type ShellPage = "overview" | "findings" | "runs" | "new" | "settings" | { project: string };

const same = (current: ShellPage | undefined, page: ShellPage) =>
  typeof page === "string" ? current === page : typeof current === "object" && current.project === page.project;

const menuItem = "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-ink hover:bg-soft";

function NavItem({ href, icon, label, detail, live, active, parent }: { href: string; icon?: IconName; label: string; detail?: string | null; live?: boolean; active: boolean; parent: boolean }) {
  const title = detail ? `${label} · ${detail}` : label;
  return (
    <li className="shrink-0">
      <a
        href={href}
        aria-current={active ? (parent ? "true" : "page") : undefined}
        className={`relative flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm -outline-offset-2 ${active ? "bg-panel font-medium text-ink shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:bg-soft hover:text-ink"}`}
      >
        {icon && <Icon name={icon} />}
        <span className="min-w-0" title={title}>
          <span className="block truncate">{label}</span>
          {detail && <span className="block truncate text-xs font-normal text-muted">{detail}</span>}
        </span>
        {live && <span className="ml-auto flex shrink-0 items-center"><span aria-hidden className="size-2 rounded-full bg-ok" /><span className="sr-only">, a run is going</span></span>}
      </a>
    </li>
  );
}

function AccountMenu({ user, className }: { user: Shell["user"]; className: string }) {
  const who = user.name || user.email;
  return (
    <Menu className={`group relative ${className}`}>
      <summary aria-label={`Account: ${who}`} className="flex min-h-10 cursor-pointer list-none items-center gap-2.5 rounded-md px-2 hover:bg-soft [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-ink text-xs font-medium text-paper">{initials(who)}</span>
        <span className="min-w-0 flex-1 max-md:sr-only">
          <span className="block truncate text-sm font-medium" title={who}>{who}</span>
        </span>
        <Icon name="chevrons" className="size-4 text-muted max-md:hidden" />
      </summary>
      <div className="absolute z-30 w-64 rounded-lg md:w-full border border-line bg-panel p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.12)] max-md:top-full max-md:right-0 max-md:mt-1 md:bottom-full md:left-0 md:mb-1">
        <div className="px-2.5 pt-1.5 pb-2">
          <p className="truncate text-sm font-medium">Signed in as {who}</p>
          {user.name && <p className="truncate text-xs text-muted">{user.email}</p>}
        </div>
        <DocsLink className={menuItem}><Icon name="docs" />Docs</DocsLink>
        <ThemeToggle withLabel className={menuItem} />
        <SignOutButton icon className={menuItem} />
      </div>
    </Menu>
  );
}

export function AppShell({ shell, current, parent = false, wide = false, children }: { shell: Shell; current?: ShellPage; parent?: boolean; wide?: boolean; children: ReactNode }) {
  const { user, workspace } = shell;
  const marked = (page: ShellPage) => same(current, page);
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[248px_minmax(0,1fr)]">
      <a href="#main" className="sr-only z-30 bg-panel focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:px-4 focus:py-3">Skip to content</a>
      <div className="border-b border-line md:sticky md:top-0 md:z-20 md:flex md:h-dvh md:flex-col md:border-b-0 md:px-3 md:py-4">
        <div className="flex h-14 items-center justify-between gap-3 px-4 md:h-auto md:px-1.5 md:pb-4">
          <a href="/" className="flex min-w-0 items-center gap-2.5">
            <BrandMark className="size-6 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold tracking-tight max-[360px]:sr-only">trawler</span>
              <span className="hidden truncate text-xs text-muted md:block" title={workspace.name}>{workspace.name}</span>
            </span>
          </a>
          <AccountMenu user={user} className="md:hidden" />
        </div>
        <nav aria-label="Workspace" className="flex gap-1 overflow-x-auto px-2 pb-2 md:min-h-0 md:flex-1 md:flex-col md:overflow-y-auto md:p-0">
          <ul className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
            <NavItem href="/" icon="home" label="Overview" active={marked("overview")} parent={parent} />
            <NavItem href="/findings" icon="inbox" label="Findings" active={marked("findings")} parent={parent} />
            <NavItem href="/runs" icon="runs" label="All runs" active={marked("runs")} parent={parent} />
          </ul>
          <p id="nav-projects" className="hidden px-2.5 pt-6 pb-1.5 text-xs text-muted md:block">Projects · {workspace.projects.length}</p>
          <ul aria-labelledby="nav-projects" className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
            {workspace.projects.map((p) => <NavItem key={p.id} href={`/projects/${p.id}/overview`} label={p.name} detail={p.address} live={p.live} active={marked({ project: p.id })} parent={parent} />)}
            <NavItem href="/new" icon="plus" label="New project" active={marked("new")} parent={parent} />
          </ul>
          <ul className="flex shrink-0 gap-1 md:mt-auto md:flex-col md:gap-0.5 md:pt-6">
            <NavItem href="/settings" icon="settings" label="Settings" active={marked("settings")} parent={parent} />
          </ul>
        </nav>
        <RevealCurrentEntry current={typeof current === "object" ? current.project : (current ?? "")} />
        <AccountMenu user={user} className="mt-1 hidden shrink-0 md:block" />
      </div>
      <main id="main" className="min-w-0 bg-panel px-4 py-8 md:my-2 md:mr-2 md:rounded-xl md:px-[clamp(28px,4.5vw,72px)] md:py-12 md:shadow-[0_0_0_1px_var(--line)]">
        <div className={wide ? "w-full" : "mx-auto w-full max-w-3xl"}>{children}</div>
      </main>
    </div>
  );
}
