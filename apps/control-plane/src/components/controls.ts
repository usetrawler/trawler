const fieldBase = "min-w-0 rounded-md border border-line bg-panel text-ink outline-none transition-colors placeholder:text-muted hover:border-muted focus:border-ink";

export const field = `h-10 px-3 text-sm ${fieldBase}`;
export const keyField = `${field} font-mono`;
export const area = `px-3 py-2 text-sm ${fieldBase}`;

const buttonBase = "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-60 aria-disabled:cursor-wait aria-disabled:opacity-60";

export const primaryButton = `${buttonBase} bg-action text-[#171717] transition-[filter] hover:brightness-105`;
export const secondaryButton = `${buttonBase} border border-line bg-panel transition-colors hover:border-muted`;
export const textButton = "text-sm text-muted underline underline-offset-4 hover:text-ink";

export const chip = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors";
export const chipOn = `${chip} border-ink bg-ink text-paper`;
export const chipOff = `${chip} border-line text-muted hover:border-muted hover:text-ink`;
