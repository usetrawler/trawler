import { MAX_URL, type RunEventInput } from "@usetrawler/protocol";

export const blockedRequest = (jobId: string, url: string, cause?: string): RunEventInput => ({ type: "blocked_request", jobId, url: url.slice(0, MAX_URL), ...(cause ? { cause } : {}) });
