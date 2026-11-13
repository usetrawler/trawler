import type { LanguageModel, Tool, ToolSet } from "ai";
import { z } from "zod";
import { MAX_GOALS_PER_PERSONA, type Finding, type Goal, type GoalOutcome, type JobUsage, type ProjectConfig } from "@usetrawler/protocol";
import type { Budget } from "./llm.ts";
import { secondRoundPrompt } from "./prompts.ts";
import { ask, clip } from "./setup.ts";

export const MAX_SEEN_PAGES = 30;
export const MAX_PAGE_CHARS = 6000;
export const MAX_UNOPENED = 30;
export const MAX_SECOND_ROUND_GOALS = 12;
const MAX_PER_PERSON = 4;
const PAGE_URL = /^- Page URL: (\S+)$/m;
const SNAPSHOT = /### Snapshot\n```yaml\n([\s\S]*?)\n```/;
const LINK = /- link "((?:[^"\\]|\\.)*)"[^\n]*:\n\s*- \/url: (\S+)/g;

export interface SeenPage {
  url: string;
  snapshot: string;
}

export interface UnopenedLink {
  name: string;
  url: string;
}

export interface SeenPages {
  watch(tools: ToolSet): ToolSet;
  pages(): SeenPage[];
  unopened(): UnopenedLink[];
}

function placeOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}${parsed.pathname.replace(/\/\d+(?=\/|$)/g, "/{n}").replace(/\/+$/, "") || "/"}` : null;
  } catch {
    return null;
  }
}

function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? content.map((part) => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "")).join("\n") : "";
}

export function seenPages(): SeenPages {
  const seen = new Map<string, SeenPage>();
  const linked = new Map<string, UnopenedLink>();
  const keep = (result: unknown) => {
    const text = textOf(result);
    const url = PAGE_URL.exec(text)?.[1];
    const snapshot = SNAPSHOT.exec(text)?.[1];
    const place = url ? placeOf(url) : null;
    if (!url || !place || snapshot === undefined) return;
    if (!seen.has(place) && seen.size >= MAX_SEEN_PAGES) return;
    const readable = snapshot.replace(/ \[(?:ref=[a-z0-9]+|cursor=pointer)\]/g, "");
    seen.set(place, { url, snapshot: readable.slice(0, MAX_PAGE_CHARS) });
    for (const [, name, href] of readable.matchAll(LINK)) {
      let target: string;
      try {
        target = new URL(href!, url).href;
      } catch {
        continue;
      }
      const to = placeOf(target);
      if (to && new URL(target).origin === new URL(url).origin && !linked.has(to)) linked.set(to, { name: clip(name!, 100), url: target });
    }
  };
  return {
    watch: (tools) =>
      Object.fromEntries(
        Object.entries(tools).map(([name, t]) => {
          const execute = t.execute;
          if (!execute) return [name, t];
          const watched: NonNullable<Tool["execute"]> = async (input, options) => {
            const result = await execute(input, options);
            keep(result);
            return result;
          };
          return [name, { ...t, execute: watched }];
        }),
      ),
    pages: () => [...seen.values()],
    unopened: () => [...linked].filter(([place]) => !seen.has(place)).map(([, link]) => link).slice(0, MAX_UNOPENED),
  };
}

const Answer = z.object({
  passedBy: z.array(z.string()).default([]),
  goals: z.array(z.object({ id: z.string(), instruction: z.string(), personaId: z.string() })),
});

export interface SecondRound {
  goals: Goal[];
  passedBy: string[];
}

export async function planSecondRound(opts: {
  model: LanguageModel;
  modelId: string;
  budget: Budget;
  project: ProjectConfig;
  outcomes: Array<GoalOutcome & { persona: string }>;
  findings: Array<Pick<Finding, "kind" | "title"> & { persona: string }>;
  pages: SeenPage[];
  unopened: UnopenedLink[];
}): Promise<{ plan: SecondRound; usage: JobUsage }> {
  const people = new Set(opts.project.personas.map((p) => p.id));
  const taken = new Set(opts.project.goals.map((g) => g.id));
  const { answer, usage } = await ask(opts, Answer, secondRoundPrompt({ description: opts.project.description, personas: opts.project.personas, goals: opts.project.goals, outcomes: opts.outcomes, findings: opts.findings, pages: opts.pages, unopened: opts.unopened, maxGoals: MAX_SECOND_ROUND_GOALS, maxPerPerson: MAX_PER_PERSON }), (a) => {
    const unknown = [...new Set(a.goals.map((g) => g.personaId).filter((id) => !people.has(id)))];
    return [
      ...(a.goals.length === 0 ? ["there were no goals: give at least one"] : []),
      ...(unknown.length > 0 ? [`these personaId values are not people of this run: ${unknown.join(", ")}. Use only ${[...people].join(", ")}`] : []),
    ];
  });
  const goals: Goal[] = [];
  const perPerson = new Map<string, number>();
  for (const g of answer.goals) {
    const instruction = clip(g.instruction, 1000);
    const given = perPerson.get(g.personaId) ?? 0;
    if (!people.has(g.personaId) || !instruction || given >= Math.min(MAX_PER_PERSON, MAX_GOALS_PER_PERSONA) || goals.length >= MAX_SECOND_ROUND_GOALS) continue;
    const base = g.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "probe";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    perPerson.set(g.personaId, given + 1);
    goals.push({ id, instruction, personaId: g.personaId });
  }
  if (goals.length === 0) throw new Error("the second round's plan had no goal for a person of this run");
  return { plan: { goals, passedBy: answer.passedBy.map((p) => clip(p, 200)).filter(Boolean).slice(0, 30) }, usage };
}
