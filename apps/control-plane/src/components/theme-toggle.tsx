"use client";
import { useSyncExternalStore } from "react";
import { nextChoice, storedChoice, THEME_KEY, type ThemeChoice } from "./theme.ts";

const GLYPH: Record<ThemeChoice, string> = { system: "◐", light: "☀", dark: "☾" };
const NAME: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };
const DARK = "(prefers-color-scheme: dark)";
const changed = new Set<() => void>();

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK);
  changed.add(onChange);
  media.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    changed.delete(onChange);
    media.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function choose(choice: ThemeChoice) {
  try {
    if (choice === "system") readStorage()?.removeItem(THEME_KEY);
    else readStorage()?.setItem(THEME_KEY, choice);
  } catch {}
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  for (const onChange of changed) onChange();
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const choice = useSyncExternalStore(subscribe, () => storedChoice(readStorage()), (): ThemeChoice => "system");
  const systemDark = useSyncExternalStore(subscribe, () => window.matchMedia(DARK).matches, () => false);
  const next = nextChoice(choice, systemDark);
  const label = `Theme: ${NAME[choice]}. Switch to ${NAME[next]}.`;
  return (
    <button type="button" onClick={() => choose(next)} aria-label={label} title={label} className={`grid h-9 w-9 shrink-0 place-items-center border border-line bg-soft text-ink hover:border-ink ${className}`}>
      <span aria-hidden>{GLYPH[choice]}</span>
    </button>
  );
}
