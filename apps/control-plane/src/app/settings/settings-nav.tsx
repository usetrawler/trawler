import { tab, tabRow } from "../../components/controls.ts";

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
    <nav aria-label="Settings" className="mt-6 mb-8 min-w-0">
      <ul className={`${tabRow} flex-wrap`}>
        {SECTIONS.map((s) => (
          <li key={s.key} className="shrink-0">
            <a href={settingsHref(s.key)} aria-current={s.key === current ? "page" : undefined} className={tab(s.key === current)}>
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
