export const SECTIONS = [
  { key: "general", label: "General" },
  { key: "members", label: "Members" },
  { key: "model", label: "Model & budget" },
  { key: "tokens", label: "API tokens & MCP" },
  { key: "billing", label: "Billing" },
] as const;

export type Section = (typeof SECTIONS)[number]["key"];

export const sectionOf = (value: string | string[] | undefined): Section => SECTIONS.find((s) => s.key === (Array.isArray(value) ? value[0] : value))?.key ?? "general";

export const settingsHref = (section: Section) => (section === "general" ? "/settings" : `/settings?section=${section}`);

export function SettingsNav({ current }: { current: Section }) {
  return (
    <nav aria-label="Settings">
      <ul className="flex gap-1 overflow-x-auto md:flex-col">
        {SECTIONS.map((s) => (
          <li key={s.key} className="shrink-0">
            <a
              href={settingsHref(s.key)}
              aria-current={s.key === current ? "page" : undefined}
              className={`flex h-10 items-center rounded-md px-3 text-[15px] ${s.key === current ? "bg-soft font-medium text-ink" : "text-muted hover:text-ink"}`}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
