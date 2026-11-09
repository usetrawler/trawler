const fieldShape = "min-w-0 rounded-md border bg-panel text-ink outline-none transition-colors placeholder:text-muted";
const fieldBase = `${fieldShape} border-line hover:border-muted focus:border-ink focus:ring-2 focus:ring-ink/10`;

export const field = `h-10 px-3 text-base sm:text-sm ${fieldBase}`;
export const invalidField = `h-10 px-3 text-base sm:text-sm ${fieldShape} border-bad focus-visible:ring-2 focus-visible:ring-bad/30`;
export const keyField = `${field} font-mono`;
export const area = `px-3 py-2 text-base sm:text-sm ${fieldBase}`;

const buttonBase = "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-60 aria-disabled:opacity-60";

export const primaryButton = `${buttonBase} bg-action text-[#171717] transition-[filter] hover:brightness-105 disabled:bg-soft disabled:text-muted disabled:opacity-100 disabled:hover:brightness-100 aria-disabled:bg-soft aria-disabled:text-muted aria-disabled:opacity-100`;
export const secondaryButton = `${buttonBase} border border-line bg-panel transition-colors hover:border-muted aria-disabled:hover:border-line`;
export const dangerButton = `${buttonBase} border border-bad text-bad transition-colors hover:bg-bad/10`;
export const textButton = "text-sm text-muted underline underline-offset-4 hover:text-ink";

export const chip = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors";
export const chipOn = `${chip} border-ink bg-ink text-paper`;
export const chipOff = `${chip} border-line text-muted hover:border-muted hover:text-ink`;

export const sectionTitle = "text-[15px] leading-6 font-medium";
export const formTitle = "text-lg font-medium";

export const errorNote = "border-l-2 border-bad pl-3 text-sm text-bad";
export const warnNote = "border-l-2 border-warn pl-3 text-sm text-ink";
export const infoNote = "border-l-2 border-line pl-3 text-sm text-muted";

export const tabRow = "flex gap-x-5 border-b border-line sm:gap-x-6";
export const tab = (on: boolean) => `-mb-px flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 text-[15px] font-medium ${on ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`;
export const tabCount = "text-sm font-normal text-muted tabular-nums";
export const phoneEdgeFade = "max-sm:[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-28px),transparent)]";
