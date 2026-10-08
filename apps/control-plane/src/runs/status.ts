const STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Live", succeeded: "Complete", stopped_budget: "Stopped at cap", cancelled: "Cancelled", failed: "Failed", skipped: "Skipped" };

const STATUS_TONE: Record<string, string> = { succeeded: "text-ok", stopped_budget: "text-warn", failed: "text-bad", running: "text-info", queued: "text-muted", cancelled: "text-muted", skipped: "text-muted" };

export const NOTHING_TO_TEST = "Nothing in this change can be tested through the product's UI, so Trawler did not start a run.";

export const NOT_VISIBLE_HERE = "This change cannot be seen in the app as CI runs it, so Trawler did not start a run.";

export const thinCoverage = (reached: number, total: number) => total > 0 && reached * 2 < total;

export const runStatusLabel = (status: string) => STATUS_LABEL[status] ?? status;

export const runStatusTone = (status: string) => STATUS_TONE[status] ?? "";

const paddedNumber = (number: number) => String(number).padStart(4, "0");

export const runTitle = (number: number) => `Run ${paddedNumber(number)}`;

export const runPath = (number: number) => `/runs/${paddedNumber(number)}`;
