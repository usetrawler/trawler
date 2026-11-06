import type { LanguageModel } from "ai";
import { z } from "zod";
import { MAX_BRIEF, type JobUsage } from "@usetrawler/protocol";
import type { Budget } from "./llm.ts";
import { prPlanPrompt } from "./prompts.ts";
import { ask, clip } from "./setup.ts";

export const MAX_LEAD_GOALS = 8;
const GOAL_CHARS = 300;

export interface PullRequestText {
  title?: string;
  description?: string;
  changedFiles?: string[];
  environment?: string;
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
  turns: z.array(z.object({ person: z.string(), goals: z.array(z.object({ id: z.string(), instruction: z.string(), promise: z.boolean().optional().catch(undefined) })) })),
  accountFlow: z.string().optional().catch(undefined).describe('"provided" or "exercise"'),
  accountReason: z.string().optional().catch(undefined),
  notVisibleHere: z.string().optional().catch(undefined),
  brief: z.string().optional().catch(undefined),
  untried: z.array(z.object({ case: z.string(), goal: z.string() })).optional().catch(undefined),
});

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const identifierWords = (name: string) => words(name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/_/g, " "));
const contains = (haystack: string[], needle: string[]) => needle.length > 0 && haystack.some((_, i) => needle.every((w, j) => haystack[i + j] === w));
const codeShaped = (token: string) => /[a-z\d][A-Z]/.test(token) || /[A-Za-z\d]_[A-Za-z\d]/.test(token) || token.includes("/") || /[A-Za-z]\.[a-z]{1,5}$/.test(token) || /\(\)$/.test(token);

export function leaksPullRequest(instruction: string, pr: PullRequestText): string | null {
  const lower = instruction.toLowerCase();
  const goalWords = words(instruction);
  if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\.|#\d+/i.test(instruction)) return "mentions an address or a number of an issue";
  for (const file of pr.changedFiles ?? []) {
    const path = file.toLowerCase();
    const base = path.split("/").at(-1)!;
    const stem = file.split("/").at(-1)!.replace(/\.[^.]*$/, "");
    const stemWords = identifierWords(stem);
    if ((path.length >= 4 && lower.includes(path)) || (base.length >= 4 && lower.includes(base))) return "names a file";
    if (stemWords.length >= 3 && contains(goalWords, stemWords)) return "names a component";
    if (stemWords.length === 2 && /[a-z\d][A-Z]|_/.test(stem) && lower.includes(stem.toLowerCase())) return "names a component";
  }
  const source = `${pr.title ?? ""}\n${pr.description ?? ""}`;
  for (const token of source.match(/[^\s`"'()<>,;]{4,}/g) ?? []) {
    if (codeShaped(token) && lower.includes(token.replace(/[.:!?]+$/, "").toLowerCase())) return "uses a name from the code";
  }
  for (const [, code] of source.matchAll(/`([^`\n]{3,80})`/g)) {
    if (lower.includes(code!.toLowerCase())) return "uses a name from the code";
  }
  return null;
}

function problemsOf(answer: z.infer<typeof Answer>, people: LeadPerson[], pr: PullRequestText): string[] {
  return answer.turns.flatMap((turn) => [
    ...(personId(turn.person, people) ? [] : [`${JSON.stringify(turn.person)} is not one of the people; choose only ids from the list`]),
    ...turn.goals.flatMap((g) => {
      const leak = leaksPullRequest(g.instruction, pr);
      return leak ? [`goal ${JSON.stringify(g.id)} ${leak}; write it as the outcome a user should get, without file, code or address names`] : [];
    }),
    ...(typeof answer.brief === "string" && leaksPullRequest(answer.brief, pr) ? [`the brief ${leaksPullRequest(answer.brief, pr)}; say what the feature does in a user's words, without file, code or address names`] : []),
  ]).concat(untriedProblems(answer), promiseProblems(answer));
}

function untriedProblems(answer: z.infer<typeof Answer>): string[] {
  if (answer.turns.length === 0) return [];
  const untried = answer.untried ?? [];
  if (untried.length === 0) return ["untried is empty: list the cases the change implies that its title and description do not name (the other side of a check, another outcome of a decision and what a user does next, doing something again after it changed), each with the id of the goal that tries it"];
  const order = answer.turns.flatMap((t) => t.goals.map((g) => g.id));
  return untried.flatMap((u) => {
    const at = order.indexOf(u.goal);
    if (at < 0) return [`the untried case ${JSON.stringify(u.case)} points at goal ${JSON.stringify(u.goal)}, which is not in your turns; write a goal that tries it`];
    if (at >= MAX_LEAD_GOALS) return [`goal ${JSON.stringify(u.goal)} for the untried case ${JSON.stringify(u.case)} is past the limit of ${MAX_LEAD_GOALS} goals; leave out a case the pull request lists instead`];
    return [];
  });
}

function promiseProblems(answer: z.infer<typeof Answer>): string[] {
  if (answer.turns.length === 0) return [];
  const order = answer.turns.flatMap((t) => t.goals);
  const at = order.findIndex((g) => g.promise === true);
  if (at < 0) return ["no goal is marked promise: true; mark the goal that plays the main thing the change promises a user, and write it if it is missing"];
  if (at >= MAX_LEAD_GOALS) return [`the promise goal ${JSON.stringify(order[at]!.id)} is past the limit of ${MAX_LEAD_GOALS} goals; play it earlier and leave out another case the pull request lists`];
  return [];
}

export function personId(named: string, people: LeadPerson[]): string | undefined {
  if (people.some((p) => p.id === named)) return named;
  const wanted = named.trim().toLowerCase();
  const byName = people.filter((p) => p.name.trim().toLowerCase() === wanted || p.name.trim().toLowerCase().split(/\s+/)[0] === wanted);
  return byName.length === 1 ? byName[0]!.id : undefined;
}

export function settleTurns(answer: z.infer<typeof Answer>, people: LeadPerson[], pr: PullRequestText, taken: Iterable<string> = []): { turns: LeadTurn[]; dropped: number; firstDrop?: string } {
  const used = new Set(taken);
  const turns: LeadTurn[] = [];
  let kept = 0;
  let dropped = 0;
  let firstDrop: string | undefined;
  for (const turn of answer.turns) {
    const person = personId(turn.person, people);
    const goals: LeadTurn["goals"] = [];
    for (const g of turn.goals) {
      const instruction = clip(g.instruction, GOAL_CHARS);
      const why = !person ? `is for ${JSON.stringify(turn.person)}, who is not one of the people` : !instruction ? "is empty" : leaksPullRequest(instruction, pr) ?? (kept >= MAX_LEAD_GOALS ? "is over the limit of goals" : null);
      if (why) {
        dropped++;
        firstDrop ??= `${JSON.stringify(instruction.slice(0, 160))} ${why}`;
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
    if (last && last.person === person) last.goals.push(...goals);
    else turns.push({ person: person!, goals });
  }
  return { turns, dropped, ...(firstDrop ? { firstDrop } : {}) };
}

export function settleAccountFlow(answer: { accountFlow?: unknown; accountReason?: unknown }, pr: PullRequestText): { accountFlow: AccountFlow; accountReason?: string } {
  const accountFlow: AccountFlow = typeof answer.accountFlow === "string" && answer.accountFlow.trim().toLowerCase() === "exercise" ? "exercise" : "provided";
  const reason = typeof answer.accountReason === "string" ? clip(answer.accountReason, REASON_CHARS) : "";
  return { accountFlow, ...(reason && !leaksPullRequest(reason, pr) ? { accountReason: reason } : {}) };
}

export function settleNotVisible(answer: { notVisibleHere?: unknown }, turns: LeadTurn[], pr: PullRequestText): string | undefined {
  if (turns.length > 0 || !pr.environment || typeof answer.notVisibleHere !== "string") return undefined;
  const reason = clip(answer.notVisibleHere, REASON_CHARS);
  return reason && !leaksPullRequest(reason, pr) ? reason : undefined;
}

export function settleBrief(answer: { brief?: unknown }, turns: LeadTurn[], pr: PullRequestText): string | undefined {
  if (turns.length === 0 || typeof answer.brief !== "string") return undefined;
  const brief = clip(answer.brief, MAX_BRIEF);
  return brief && !leaksPullRequest(brief, pr) ? brief : undefined;
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
}): Promise<{ turns: LeadTurn[]; dropped: number; firstDrop?: string; usage: JobUsage; accountFlow: AccountFlow; accountReason?: string; notVisibleHere?: string; brief?: string }> {
  const { answer, usage } = await ask(opts, Answer, prPlanPrompt(opts), (a) => problemsOf(a, opts.people, opts.pullRequest));
  const settled = settleTurns(answer, opts.people, opts.pullRequest, opts.takenGoalIds);
  const notVisibleHere = settleNotVisible(answer, settled.turns, opts.pullRequest);
  const brief = settleBrief(answer, settled.turns, opts.pullRequest);
  return { ...settled, ...settleAccountFlow(answer, opts.pullRequest), ...(notVisibleHere ? { notVisibleHere } : {}), ...(brief ? { brief } : {}), usage };
}
