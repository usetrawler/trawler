import type { LanguageModel } from "ai";
import { z } from "zod";
import type { JobUsage } from "@usetrawler/protocol";
import type { Budget } from "./llm.ts";
import { prPlanPrompt } from "./prompts.ts";
import { ask, clip } from "./setup.ts";

export const MAX_LEAD_GOALS = 8;
const GOAL_CHARS = 300;
const SHINGLE = 5;

export interface PullRequestText {
  title?: string;
  description?: string;
  changedFiles?: string[];
}

export interface LeadPerson {
  id: string;
  name: string;
  brief: string;
  account: string | null;
}

export interface LeadTurn {
  person: string;
  goals: Array<{ id: string; instruction: string }>;
}

export type AccountFlow = "provided" | "exercise";
const REASON_CHARS = 200;

const Answer = z.object({
  turns: z.array(z.object({ person: z.string(), goals: z.array(z.object({ id: z.string(), instruction: z.string() })) })),
  accountFlow: z.string().optional().catch(undefined).describe('"provided" or "exercise"'),
  accountReason: z.string().optional().catch(undefined),
});

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const identifierWords = (name: string) => words(name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/_/g, " "));
const contains = (haystack: string[], needle: string[]) => needle.length > 0 && haystack.some((_, i) => needle.every((w, j) => haystack[i + j] === w));
const codeShaped = (token: string) => /[a-z\d][A-Z]/.test(token) || /[A-Za-z\d]_[A-Za-z\d]/.test(token) || token.includes("/") || /[A-Za-z]\.[a-z]{1,5}$/.test(token) || /\(\)$/.test(token);

function shingles(list: string[]): Set<string> {
  return new Set(list.map((_, i) => list.slice(i, i + SHINGLE)).filter((s) => s.length === SHINGLE).map((s) => s.join(" ")));
}

export function leaksPullRequest(instruction: string, pr: PullRequestText): string | null {
  const lower = instruction.toLowerCase();
  const goalWords = words(instruction);
  if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\.|#\d+|\bpull request\b|\bPR\b/i.test(instruction)) return "mentions an address or the pull request";
  for (const file of pr.changedFiles ?? []) {
    const path = file.toLowerCase();
    const base = path.split("/").at(-1)!;
    const stem = file.split("/").at(-1)!.replace(/\.[^.]*$/, "");
    const stemWords = identifierWords(stem);
    if ((path.length >= 4 && lower.includes(path)) || (base.length >= 4 && lower.includes(base))) return "names a file";
    if (stemWords.length >= 3 || (stemWords.length === 2 && /[a-z\d][A-Z]|_/.test(stem))) {
      if (contains(goalWords, stemWords)) return "names a component";
    }
  }
  const source = `${pr.title ?? ""}\n${pr.description ?? ""}`;
  for (const token of source.match(/[^\s`"'()<>,;]{4,}/g) ?? []) {
    if (codeShaped(token) && lower.includes(token.replace(/[.:!?]+$/, "").toLowerCase())) return "uses a name from the code";
  }
  for (const [, code] of source.matchAll(/`([^`\n]{3,80})`/g)) {
    if (lower.includes(code!.toLowerCase())) return "uses a name from the code";
  }
  const title = words(pr.title ?? "");
  if (title.length >= 3 && contains(goalWords, title)) return "repeats the pull request's title";
  const seen = shingles(words(source));
  for (const s of shingles(goalWords)) if (seen.has(s)) return "repeats the pull request's words";
  return null;
}

function problemsOf(answer: z.infer<typeof Answer>, people: LeadPerson[], pr: PullRequestText): string[] {
  const known = new Set(people.map((p) => p.id));
  return answer.turns.flatMap((turn) => [
    ...(known.has(turn.person) ? [] : [`${JSON.stringify(turn.person)} is not one of the people; choose only ids from the list`]),
    ...turn.goals.flatMap((g) => {
      const leak = leaksPullRequest(g.instruction, pr);
      return leak ? [`goal ${JSON.stringify(g.id)} ${leak}; write it as the outcome a user wants, in your own words, without anything from the pull request`] : [];
    }),
  ]);
}

export function settleTurns(answer: z.infer<typeof Answer>, people: LeadPerson[], pr: PullRequestText, taken: Iterable<string> = []): { turns: LeadTurn[]; dropped: number } {
  const known = new Set(people.map((p) => p.id));
  const used = new Set(taken);
  const turns: LeadTurn[] = [];
  let kept = 0;
  let dropped = 0;
  for (const turn of answer.turns) {
    const goals: LeadTurn["goals"] = [];
    for (const g of turn.goals) {
      const instruction = clip(g.instruction, GOAL_CHARS);
      if (!known.has(turn.person) || !instruction || leaksPullRequest(instruction, pr) || kept >= MAX_LEAD_GOALS) {
        dropped++;
        continue;
      }
      let id = `pr-goal-${kept + 1}`;
      for (let n = kept + 2; used.has(id); n++) id = `pr-goal-${n}`;
      used.add(id);
      goals.push({ id, instruction });
      kept++;
    }
    if (goals.length === 0) continue;
    const last = turns.at(-1);
    if (last?.person === turn.person) last.goals.push(...goals);
    else turns.push({ person: turn.person, goals });
  }
  return { turns, dropped };
}

export function settleAccountFlow(answer: { accountFlow?: unknown; accountReason?: unknown }, pr: PullRequestText): { accountFlow: AccountFlow; accountReason?: string } {
  const accountFlow: AccountFlow = typeof answer.accountFlow === "string" && answer.accountFlow.trim().toLowerCase() === "exercise" ? "exercise" : "provided";
  const reason = typeof answer.accountReason === "string" ? clip(answer.accountReason, REASON_CHARS) : "";
  return { accountFlow, ...(reason && !leaksPullRequest(reason, pr) ? { accountReason: reason } : {}) };
}

export async function planForPullRequest(opts: {
  model: LanguageModel;
  modelId: string;
  budget: Budget;
  url: string;
  pullRequest: PullRequestText;
  features: string[];
  people: LeadPerson[];
  goals: Array<{ person: string; instruction: string }>;
  takenGoalIds?: string[];
  page?: string;
}): Promise<{ turns: LeadTurn[]; dropped: number; usage: JobUsage; accountFlow: AccountFlow; accountReason?: string }> {
  const { answer, usage } = await ask(opts, Answer, prPlanPrompt(opts), (a) => problemsOf(a, opts.people, opts.pullRequest));
  return { ...settleTurns(answer, opts.people, opts.pullRequest, opts.takenGoalIds), ...settleAccountFlow(answer, opts.pullRequest), usage };
}
