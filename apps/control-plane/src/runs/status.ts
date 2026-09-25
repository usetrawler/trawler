const STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Live", succeeded: "Complete", stopped_budget: "Stopped at cap", cancelled: "Cancelled", failed: "Failed" };

export const runStatusLabel = (status: string) => STATUS_LABEL[status] ?? status;

export const runTitle = (number: number) => `Run ${String(number).padStart(4, "0")}`;
