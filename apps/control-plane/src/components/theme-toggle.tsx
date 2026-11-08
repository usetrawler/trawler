"use client";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { Icon } from "./icon.tsx";
import { nextChoice, storedChoice, THEME_KEY, THEME_SCRIPT, type ThemeChoice } from "./theme.ts";

const NAME: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };
const DARK = "(prefers-color-scheme: dark)";
const changed = new Set<() => void>();

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK);
  changed.add(onChange);
  media.addEventListener("change", onChange);
  return () => {
    changed.delete(onChange);
    media.removeEventListener("change", onChange);
  };
}

function readStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function show(choice: ThemeChoice) {
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  for (const onChange of changed) onChange();
}

function shownChoice(): ThemeChoice {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "light" || theme === "dark" ? theme : "system";
}

export function choose(choice: ThemeChoice) {
  try {
    if (choice === "system") readStorage()?.removeItem(THEME_KEY);
    else readStorage()?.setItem(THEME_KEY, choice);
  } catch {}
  show(choice);
}

export function ThemeScript() {
  useLayoutEffect(() => {
    const showStored = () => show(storedChoice(readStorage()));
    const fromAnotherTab = (event: StorageEvent) => {
      if (event.key === THEME_KEY || event.key === null) showStored();
    };
    showStored();
    window.addEventListener("storage", fromAnotherTab);
    return () => window.removeEventListener("storage", fromAnotherTab);
  }, []);
  return <script type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}

export function ThemeToggle({ className = "grid size-9 shrink-0 place-items-center rounded-md border border-line bg-panel text-ink hover:border-muted/60", withLabel = false }: { className?: string; withLabel?: boolean } = {}) {
  const choice = useSyncExternalStore(subscribe, shownChoice, (): ThemeChoice => "system");
  const systemDark = useSyncExternalStore(subscribe, () => window.matchMedia(DARK).matches, () => false);
  const next = nextChoice(choice, systemDark);
  const label = `Theme: ${NAME[choice]}. Switch to ${NAME[next]}.`;
  return (
    <button type="button" onClick={() => choose(next)} title={label} aria-label={withLabel ? undefined : label} className={className}>
      <span className="in-data-[theme]:hidden"><Icon name="contrast" /></span>
      <span className="hidden in-data-[theme=light]:inline"><Icon name="sun" /></span>
      <span className="hidden in-data-[theme=dark]:inline"><Icon name="moon" /></span>
      {withLabel && <span>Theme: {NAME[choice]}</span>}
    </button>
  );
}
