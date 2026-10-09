import type { Goal, Untrusted } from "./dom.ts";

export const GROUPS = ["confirmed", "refuted", "inconclusive", "couldNotJudge", "notJudged", "friction", "dismissed"] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABEL: Record<Group, string> = { confirmed: "Confirmed", refuted: "Refuted", inconclusive: "Inconclusive", couldNotJudge: "Could not be judged", notJudged: "Not judged", friction: "Friction", dismissed: "Not a bug" };

export interface Item { key: string; group: string; severity: string; verdict: string | null; person: string; goal: Goal; title: Untrusted; evidence: number; reason?: Untrusted }

export interface Report {
  id: string; number: number; url: string; status: string; live: boolean; headline: string; headlineDetail: Untrusted | null; project: { id: string }; plan: string | null; target: string; model: string;
  createdAt: string | null; startedAt: string | null; finishedAt: string | null; costUsd: number; budgetUsd: number; goals: { reached: number; total: number; notReached: Goal[] };
  people: Array<{ id: string; name: string; state: string; defects: number; friction: number; goals: Array<{ id: string; goal: Goal; status: string | null; note: Untrusted | null }> }>;
  findings: Record<Group, { total: number; more: number; items: Item[] }>;
}

export interface Compared {
  swapped: boolean;
  base: { number: number; headline: string; headlineDetail: Untrusted | null; status: string };
  head: { number: number; headline: string; headlineDetail: Untrusted | null; status: string };
  goals: { items: Array<{ person: string; goal: Goal; base: string; head: string; change: string }>; total: number; more: number; unchanged: number };
  findings: {
    stillReported: { items: Array<{ title: Untrusted; goal: Goal; base: { key: string; verdict: string }; head: { key: string; verdict: string } }>; total: number; more: number };
    onlyInBase: { items: Array<{ key: string; verdict: string; title: Untrusted; goal: Goal; goalInHead: string }>; total: number; more: number };
    onlyInHead: { items: Array<{ key: string; verdict: string; title: Untrusted; goal: Goal }>; total: number; more: number };
  };
  caveats: string[];
}

export interface Detail {
  run: number; key: string; group: string; severity: string; verdict: string | null; person: string; goal: Goal; groupedUnder: string | null;
  title: Untrusted; observed: Untrusted; reproduction: Untrusted; quote: Untrusted | null; page: Untrusted | null;
  replay: { completed: boolean | null; observed: Untrusted | null } | null; sameReports: Array<{ key: string; title: Untrusted }>;
  dismissal: { reason: Untrusted; by: string; at: string | null } | null; evidence: Array<{ ref: string; kind: "screenshot" | "trail"; label: string }>;
}

export interface RunLine {
  id: string; number: number; status: string; createdAt: string | null; project: { id: string; name: string }; plan: string | null;
  confirmedDefects: number; hasUncheckedDefects: boolean; goalsReached: number; goalsTotal: number; costUsd: number;
}

export interface RunList { runs: RunLine[]; nextBefore: number | null; counts: { all: number; completed: number; attention: number } }
export interface ProjectList { projects: Array<{ id: string; name: string; site: string | null; targetUrl: string; lastRun: RunLine | null }>; nextCursor: string | null }
export interface Started { id: string; number: number; url: string; replayed: boolean; people: number; limit: { runsPerDay: number; spendUsdPerDay: number; runs: number; spentUsd: number; nextFreeAt: string | null } | null }
export interface Stopped { id: string; status: string; stopped: boolean }

export type Result = { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };

export const failureText = (result: Result): string => result.content?.find((c) => c.type === "text")?.text ?? "Trawler could not answer.";

const has = (value: unknown, ...keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && keys.every((k) => k in value);
export const isReport = (v: unknown): v is Report => has(v, "findings", "people", "headline");
export const isCompared = (v: unknown): v is Compared => has(v, "caveats", "goals", "base", "head");
export const isDetail = (v: unknown): v is Detail => has(v, "observed", "reproduction", "evidence", "key");
export const isRunList = (v: unknown): v is RunList => has(v, "runs", "counts");
export const isProjectList = (v: unknown): v is ProjectList => has(v, "projects");
export const isStarted = (v: unknown): v is Started => has(v, "number", "url", "replayed");
export const isStopped = (v: unknown): v is Stopped => has(v, "stopped", "status", "id") && !("findings" in v);

export type Payload = { view: "report"; data: Report } | { view: "compare"; data: Compared } | { view: "finding"; data: Detail } | { view: "runs"; data: RunList; args?: Record<string, unknown> } | { view: "projects"; data: ProjectList } | { view: "started"; data: Started } | { view: "stopped"; data: Stopped };

export function payloadOf(value: unknown): Payload | null {
  if (isReport(value)) return { view: "report", data: value };
  if (isCompared(value)) return { view: "compare", data: value };
  if (isDetail(value)) return { view: "finding", data: value };
  if (isRunList(value)) return { view: "runs", data: value };
  if (isProjectList(value)) return { view: "projects", data: value };
  if (isStarted(value)) return { view: "started", data: value };
  if (isStopped(value)) return { view: "stopped", data: value };
  return null;
}
