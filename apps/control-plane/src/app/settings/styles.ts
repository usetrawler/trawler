export const panel = "flex flex-col gap-4 border-b border-line pb-8 last:border-b-0 last:pb-0";
import { dangerButton, errorNote, formTitle, secondaryButton } from "../../components/controls.ts";

export const heading = formTitle;
export const button = `${secondaryButton} aria-disabled:cursor-wait`;
export const danger = `${dangerButton} aria-disabled:cursor-wait`;
export const alert = errorNote;
export const keepButton = "h-10 px-2 text-sm text-muted hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-60";
