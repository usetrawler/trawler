const STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Live", succeeded: "Complete", stopped_budget: "Stopped at cap", cancelled: "Cancelled", failed: "Failed" };

const STATUS_TONE: Record<string, string> = { succeeded: "text-ok", stopped_budget: "text-warn", failed: "text-bad", running: "text-info", queued: "text-muted", cancelled: "text-muted" };

export const runStatusLabel = (status: string) => STATUS_LABEL[status] ?? status;

export const runStatusTone = (status: string) => STATUS_TONE[status] ?? "";

export const runTitle = (number: number) => `Run ${String(number).padStart(4, "0")}`;
