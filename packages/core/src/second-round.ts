import type { LanguageModel, Tool, ToolSet } from "ai";
import { z } from "zod";
import { type Finding, type Goal, type GoalOutcome, type JobUsage, type ProjectConfig } from "@usetrawler/protocol";
import type { Budget } from "./llm.ts";
import { secondRoundPrompt } from "./prompts.ts";
import type { SecretScrubber } from "./secrets.ts";
import { ask, clip } from "./setup.ts";

export const MAX_SEEN_PAGES = 30;
export const MAX_PAGE_CHARS = 6000;
export const MAX_UNOPENED = 30;
const MAX_LINKED = 300;
const MAX_INSTRUCTION = 600;
export const MAX_SECOND_ROUND_GOALS = 12;
const MAX_PER_PERSON = 4;
const PAGE_URL = /^- Page URL: (\S+)$/m;
const SNAPSHOT = /### Snapshot\n```yaml\n([\s\S]*?)\n```/;
const LINK = /- link "((?:[^"\\]|\\.)*)"[^\n]*:\n\s*- \/url: (\S+)/g;

export interface SeenPage {
  url: string;
  snapshot: string;
  seenBy: string[];
}

export interface UnopenedLink {
  name: string;
  url: string;
  seenBy: string[];
}

export interface SeenPages {
  watch(tools: ToolSet, person: string): ToolSet;
  pages(): SeenPage[];
  unopened(): UnopenedLink[];
}

function placeOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const numbered = (path: string) => path.replace(/\/\d+(?=\/|$)/g, "/{n}").replace(/\/+$/, "");
    const route = /^#!?\//.test(parsed.hash) ? numbered(parsed.hash.split("?")[0]!) : "";
    return `${parsed.origin}${numbered(parsed.pathname) || "/"}${route}`;
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
  const opened = new Set<string>();
  const linked = new Map<string, UnopenedLink>();
  const keep = (result: unknown, person: string) => {
    const text = textOf(result);
    const url = PAGE_URL.exec(text)?.[1];
    const snapshot = SNAPSHOT.exec(text)?.[1];
    const place = url ? placeOf(url) : null;
    if (!url || !place || snapshot === undefined) return;
    opened.add(place);
    const readable = snapshot.replace(/ \[(?:ref=[a-z0-9]+|cursor=pointer)\]/g, "");
    const kept = seen.get(place);
    const seenBy = [...new Set([...(kept?.seenBy ?? []), person])];
    if (kept && readable.length < kept.snapshot.length) kept.seenBy = seenBy;
    else if (kept || seen.size < MAX_SEEN_PAGES) seen.set(place, { url, snapshot: readable.slice(0, MAX_PAGE_CHARS), seenBy });
    for (const [, name, href] of readable.matchAll(LINK)) {
      let target: URL;
      try {
        target = new URL(href!, url);
      } catch {
        continue;
      }
      const to = placeOf(target.href);
      if (!to || target.origin !== new URL(url).origin) continue;
      const known = linked.get(to);
      if (known) {
        if (!known.seenBy.includes(person)) known.seenBy.push(person);
        continue;
      }
      if (linked.size >= MAX_LINKED) continue;
      target.search = "";
      linked.set(to, { name: clip(name!.replace(/\\(.)/g, "$1"), 100), url: target.href, seenBy: [person] });
    }
  };
  return {
    watch: (tools, person) =>
      Object.fromEntries(
        Object.entries(tools).map(([name, t]) => {
          const execute = t.execute;
          if (!execute) return [name, t];
          const watched: NonNullable<Tool["execute"]> = async (input, options) => {
            const result = await execute(input, options);
            keep(result, person);
            return result;
          };
          return [name, { ...t, execute: watched }];
        }),
      ),
    pages: () => [...seen.values()],
    unopened: () => [...linked].filter(([place]) => !opened.has(place)).map(([, link]) => link).slice(0, MAX_UNOPENED),
  };
}

function notPlanned(err: unknown): string {
  const said = err instanceof Error ? err.message : String(err);
  const why = said.replace(/^the setup model could not propose a project: /, "").replace(/, so no project was proposed$/, "").replaceAll("the setup model", "the model");
  return `the lead could not plan a second round: ${why}`;
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
  scrubber: SecretScrubber;
  project: ProjectConfig;
  outcomes: Array<GoalOutcome & { persona: string }>;
  findings: Array<Pick<Finding, "kind" | "title"> & { persona: string }>;
  pages: SeenPage[];
  unopened: UnopenedLink[];
}): Promise<{ plan: SecondRound; usage: JobUsage }> {
  const people = new Set(opts.project.personas.map((p) => p.id));
  const taken = new Set(opts.project.goals.map((g) => g.id));
  const prompt = opts.scrubber.scrub(secondRoundPrompt({ description: opts.project.description, setup: opts.project.setup, personas: opts.project.personas, goals: opts.project.goals, outcomes: opts.outcomes, findings: opts.findings, pages: opts.pages, unopened: opts.unopened, maxGoals: MAX_SECOND_ROUND_GOALS, maxPerPerson: MAX_PER_PERSON }));
  const { answer, usage } = await ask(opts, Answer, prompt, (a) => {
    const unknown = [...new Set(a.goals.map((g) => g.personaId).filter((id) => !people.has(id)))];
    return [
      ...(a.goals.length === 0 ? ["there were no goals: give at least one"] : []),
      ...(unknown.length > 0 ? [`these personaId values are not people of this run: ${unknown.join(", ")}. Use only ${[...people].join(", ")}`] : []),
    ];
  }).catch((err: unknown) => {
    throw new Error(notPlanned(err), { cause: err });
  });
  const goals: Goal[] = [];
  const perPerson = new Map<string, number>();
  for (const g of answer.goals) {
    const instruction = clip(g.instruction, MAX_INSTRUCTION);
    const given = perPerson.get(g.personaId) ?? 0;
    if (!people.has(g.personaId) || !instruction || given >= MAX_PER_PERSON || goals.length >= MAX_SECOND_ROUND_GOALS) continue;
    const base = g.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50).replace(/^-+|-+$/g, "") || "probe";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    perPerson.set(g.personaId, given + 1);
    goals.push({ id, instruction, personaId: g.personaId });
  }
  if (goals.length === 0) throw new Error("the lead's plan for the second round had no goal for a person of this run");
  return { plan: { goals, passedBy: answer.passedBy.map((p) => clip(p, 200)).filter(Boolean).slice(0, 30) }, usage };
}
