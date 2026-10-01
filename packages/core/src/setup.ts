import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { ProjectConfigSchema, type JobUsage, type ProjectConfig } from "@usetrawler/protocol";
import { type Budget, tallyStep } from "./llm.ts";
import { describePrompt, setupPrompt } from "./prompts.ts";

const MAX_PERSONAS = 4;
const MAX_GOALS_PER_PERSONA = 4;
const PAGE_CHARS = 12_000;
const DOCS_CHARS = 8_000;
const MAX_FOCUS_CHARS = 500;
export const MAX_FEATURES = 6;
export const MAX_CHOSEN_FEATURES = 10;
export const MAX_FEATURE_TITLE = 80;
export const MAX_FEATURE_CHARS = 300;
export const MAX_DESCRIPTION_CHARS = 2000;
const SETUP_OUTPUT_TOKENS = 16_000;
const SETUP_REPLIES = 2;

const MAX_HTML_CHARS = 2_000_000;
const DROPPED_ELEMENTS = new Set(["script", "style", "noscript", "svg", "template"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : "�";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  let lastSolid = "";
  for (let i = from; i < html.length; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && lastSolid === "=") quote = c;
    else if (c === ">") return i;
    if (!/\s/.test(c)) lastSolid = c;
  }
  return -1;
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of tag.matchAll(/(?<=^|[\s"'/])([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    found.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return found;
}

function cutAt(text: string, maxChars: number): string {
  const cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function pageText(input: string, maxChars: number): string {
  const html = input.slice(0, MAX_HTML_CHARS);
  const parts: string[] = [];
  let description = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 2);
      if (close === -1) break;
      parts.push(" ");
      i = close + 3;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (!/[a-zA-Z\/!?]/.test(next)) {
      parts.push("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + 1);
    if (end === -1) break;
    const tag = html.slice(lt + 1, end);
    const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(tag)?.[0]?.toLowerCase() ?? "";
    parts.push(" ");
    i = end + 1;
    if (name === "meta" && !description) {
      const attrs = attributes(tag);
      if (attrs.get("name")?.toLowerCase() === "description") description = attrs.get("content") ?? "";
    }
    if (DROPPED_ELEMENTS.has(name) && !tag.endsWith("/")) {
      const closer = new RegExp(`</${name}(?=[\\s/>])`, "ig");
      closer.lastIndex = i;
      const found = closer.exec(html);
      if (!found) break;
      const closeEnd = html.indexOf(">", found.index);
      i = closeEnd === -1 ? html.length : closeEnd + 1;
    }
  }
  const text = decodeEntities(`${description ? `${description} ` : ""}${parts.join("")}`).replace(/\s+/g, " ").trim();
  return cutAt(text, maxChars);
}

function httpAddress(url: string): string {
  const refused = new RangeError("only plain http(s) addresses without credentials can be set up");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refused;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw refused;
  return parsed.href;
}

const clip = (text: string, max: number) => cutAt(text.trim(), max).trim();

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function uniqueIds<T extends { id: string }>(items: T[], fallback: string): T[] {
  const seen = new Set<string>();
  return items.map((item, i) => {
    const base = slug(item.id).slice(0, 40).replace(/-+$/, "") || `${fallback}-${i + 1}`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    seen.add(id);
    return { ...item, id };
  });
}

const GoalRef = z.object({ person: z.string(), goal: z.string() });
const GoalProposal = z.object({ id: z.string(), instruction: z.string(), needs: z.array(GoalRef).optional() });
const PersonProposal = z.object({ id: z.string(), name: z.string(), brief: z.string(), signsIn: z.boolean(), goals: z.array(GoalProposal) });
const PlayOrder = z.array(GoalRef);
const ProposalSchema = z.object({ name: z.string(), description: z.string(), personas: z.array(PersonProposal), playOrder: PlayOrder.optional() });
const PeopleSchema = z.object({ personas: z.array(PersonProposal), playOrder: PlayOrder.optional() });
export const SIGN_UP = ["open", "closed", "unclear"] as const;
export type SignUp = (typeof SIGN_UP)[number];
const SummarySchema = z.object({ name: z.string(), description: z.string(), signUp: z.enum(SIGN_UP), features: z.array(z.object({ title: z.string(), summary: z.string() })) });

export class SetupModelFailed extends Error {}

function noPlan(finishReason: string | undefined, tries: number): string {
  const count = tries === 1 ? "1 try" : `${tries} tries`;
  if (finishReason === "length") return `the setup model ran out of room before it finished the plan (${count})`;
  if (finishReason === "content-filter") return `the provider's content filter stopped the setup model before it finished the plan (${count})`;
  return `the setup model gave no usable plan (${count})`;
}

async function askOnce<T>(opts: { model: LanguageModel; budget: Budget }, schema: z.ZodType<T>, prompt: string, usage: JobUsage): Promise<{ answer: T | null; finishReason?: string }> {
  let result;
  try {
    result = await generateText({
      model: opts.model,
      output: Output.object({ schema }),
      prompt,
      maxOutputTokens: SETUP_OUTPUT_TOKENS,
      providerOptions: { openrouter: { provider: { require_parameters: true } } },
      onStepEnd: (step) => void tallyStep(usage, opts.budget, step),
    });
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) return { answer: null, finishReason: err.finishReason };
    throw err;
  }
  try {
    return { answer: result.output as T, finishReason: result.finishReason };
  } catch (err) {
    if (NoOutputGeneratedError.isInstance(err)) return { answer: null, finishReason: result.finishReason };
    throw err;
  }
}

async function ask<T>(opts: { model: LanguageModel; modelId: string; budget: Budget }, schema: z.ZodType<T>, prompt: string, problemsOf: (answer: T) => string[] = () => []): Promise<{ answer: T; usage: JobUsage }> {
  if (opts.budget.exceeded) throw spent();
  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
  let answer: T | null = null;
  let flawed: T | null = null;
  let finishReason: string | undefined;
  let tries = 0;
  let asking = prompt;
  try {
    while (answer === null && tries < SETUP_REPLIES && !opts.budget.exceeded) {
      tries++;
      try {
        ({ answer, finishReason } = await askOnce(opts, schema, asking, usage));
      } catch (err) {
        if (flawed === null) throw err;
        break;
      }
      const problems = answer === null ? [] : problemsOf(answer);
      if (answer !== null && problems.length > 0 && tries < SETUP_REPLIES && !opts.budget.exceeded) {
        flawed = answer;
        answer = null;
        asking = `${prompt}\n\nYour previous answer was refused. Answer again with the same structure and fix:\n${problems.map((p) => `- ${p}`).join("\n")}`;
      }
    }
    answer ??= flawed;
  } catch (err) {
    throw new SetupModelFailed(`the setup model could not propose a project: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (answer === null) throw new SetupModelFailed(`${noPlan(finishReason, tries)}${tries < SETUP_REPLIES ? "; the setup budget is spent" : ""}`);
  return { answer, usage };
}

const spent = () => new Error("the budget is already spent, so no project was proposed");

export interface ProductPage {
  url: string;
  docsUrl?: string;
  page: string;
  docs?: string;
}

export async function readProduct(opts: { url: string; docsUrl?: string; fetchText: (url: string) => Promise<string> }): Promise<ProductPage> {
  const url = httpAddress(opts.url);
  const docsUrl = opts.docsUrl?.trim() ? httpAddress(opts.docsUrl.trim()) : undefined;
  const [pageRead, docsRead] = await Promise.allSettled([opts.fetchText(url), docsUrl ? opts.fetchText(docsUrl) : Promise.resolve(undefined)]);
  if (pageRead.status === "rejected") {
    const reason = pageRead.reason instanceof Error ? pageRead.reason.message : String(pageRead.reason);
    throw new Error(`could not read ${url}: ${reason}`);
  }
  const docs = docsRead.status === "fulfilled" && docsRead.value !== undefined ? pageText(docsRead.value, DOCS_CHARS) : undefined;
  return { url, ...(docsUrl ? { docsUrl } : {}), page: pageText(pageRead.value, PAGE_CHARS), ...(docs !== undefined ? { docs } : {}) };
}

export interface ProductSummary {
  name: string;
  description: string;
  signUp: SignUp;
  features: { title: string; summary: string }[];
}

export async function describeProduct(opts: { model: LanguageModel; modelId: string; budget: Budget; product: ProductPage }): Promise<{ summary: ProductSummary; usage: JobUsage }> {
  const { answer, usage } = await ask(opts, SummarySchema, describePrompt(opts.product));
  const seen = new Set<string>();
  const features = answer.features
    .map((f) => ({ title: clip(f.title, MAX_FEATURE_TITLE), summary: clip(f.summary, 300) }))
    .filter((f) => f.title && !seen.has(f.title.toLowerCase()) && seen.add(f.title.toLowerCase()))
    .slice(0, MAX_FEATURES);
  if (features.length === 0) throw new SetupModelFailed("the setup model found no features on the page");
  return { summary: { name: clip(answer.name, 100) || new URL(opts.product.url).hostname, description: clip(answer.description, 600), signUp: answer.signUp, features }, usage };
}

export interface ProposedPlan {
  project: ProjectConfig;
  signsIn: string[];
}

function inPlayOrder<G extends { from: string; personaId: string }>(goals: G[], playOrder: z.infer<typeof PlayOrder>): G[] {
  const left = [...goals];
  const ordered: G[] = [];
  for (const step of playOrder) {
    const i = left.findIndex((g) => g.from === `${slug(step.person)}\0${slug(step.goal)}`);
    if (i < 0) continue;
    const personaId = left[i]!.personaId;
    const earlier = left.slice(0, i + 1).filter((g) => g.personaId === personaId);
    for (const g of earlier) left.splice(left.indexOf(g), 1);
    ordered.push(...earlier);
  }
  return [...ordered, ...left];
}

const refOf = (ref: z.infer<typeof GoalRef>) => `${slug(ref.person)}\0${slug(ref.goal)}`;
const NAME_PARTICLES = new Set(["da", "de", "del", "della", "der", "di", "do", "dos", "du", "la", "le", "van", "von", "bin", "binti", "al", "el", "y"]);
const HUMAN_NAME = /^(?:\p{Lu}[\p{L}\p{M}'’.-]*|\p{Lo}[\p{Lo}\p{M}]*)$/u;
const humanWords = (name: string) => {
  const words = name.split(/\s+/);
  return words.length <= 4 && HUMAN_NAME.test(words[0]!) && words.every((w) => HUMAN_NAME.test(w) || NAME_PARTICLES.has(w));
};
const ROLE_WORDS = new Set(["admin", "administrator", "manager", "employee", "user", "reviewer", "approver", "customer", "client", "owner", "member", "guest", "visitor", "lead", "staff", "hr", "support", "agent", "operator", "editor", "author", "buyer", "seller", "tester", "persona", "person"]);
const humanName = (name: string) => humanWords(name) && !slug(name).split("-").some((w) => ROLE_WORDS.has(w));
const firstName = (name: string) => name.trim().split(/\s+/)[0]!;
const CALENDAR = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today", "tomorrow", "yesterday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
const NOT_PEOPLE = new Set(["everyone", "everybody", "someone", "somebody", "anyone", "anybody", "nobody", "no-one", "i", "you", "we", "they", "he", "she", "it", "the", "a", "an", "this", "that", "your", "my", "our", "their", "his", "her"]);
const NAMED_ACTOR = /(?<=(?:^|\s)\p{Ll}+[,;:]? )(\p{Lu}\p{Ll}+)(?:['’]s\b| (?:submitted|sent|created|approved|reviewed|rejected|posted|shared|invited|requested|made|wrote|added|uploaded|booked|ordered|assigned|accepted|declined|edited|updated|deleted|published)\b)/gu;
const mentions = (text: string, name: string) => new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "iu").test(text);

function dependencyOrder<G extends { from: string; personaId: string; needs?: z.infer<typeof GoalRef>[] }>(goals: G[]): G[] | null {
  const byRef = new Map(goals.map((g) => [g.from, g]));
  const before = new Map<G, Set<G>>(goals.map((g) => [g, new Set<G>()]));
  goals.forEach((g, i) => {
    const previous = goals.slice(0, i).reverse().find((o) => o.personaId === g.personaId);
    if (previous) before.get(g)!.add(previous);
    for (const ref of g.needs ?? []) {
      const needed = byRef.get(refOf(ref));
      if (needed && needed !== g && needed.personaId !== g.personaId) before.get(g)!.add(needed);
    }
  });
  const placed = new Set<G>();
  const ordered: G[] = [];
  while (ordered.length < goals.length) {
    const next = goals.find((g) => !placed.has(g) && [...before.get(g)!].every((b) => placed.has(b)));
    if (!next) return null;
    placed.add(next);
    ordered.push(next);
  }
  return ordered;
}

const usable = (p: z.infer<typeof PersonProposal>) => Boolean(p.name.trim() && p.brief.trim() && p.goals.some((g) => g.instruction.trim()));

function teamProblems(answer: { personas: z.infer<typeof PersonProposal>[]; playOrder?: z.infer<typeof PlayOrder> }, product: string): string[] {
  const problems: string[] = [];
  const people = answer.personas.filter(usable);
  for (const p of people) {
    if (!humanName(p.name.trim())) problems.push(`person ${JSON.stringify(p.id)} is named ${JSON.stringify(p.name)}; give every person a human first name and keep the role in the brief`);
  }
  const nameOf = new Map(people.map((p) => [slug(p.id), p.name.trim()]));
  const known = new Set(people.flatMap((p) => p.goals.map((g) => `${slug(p.id)}\0${slug(g.id)}`)));
  for (const p of people) {
    for (const g of p.goals) {
      for (const ref of g.needs ?? []) {
        const name = nameOf.get(slug(ref.person));
        if (!known.has(refOf(ref))) problems.push(`goal ${JSON.stringify(g.id)} of ${JSON.stringify(p.id)} needs ${JSON.stringify(ref.goal)} of ${JSON.stringify(ref.person)}, which is not in the plan; name only goals of people in the plan`);
        else if (name && slug(ref.person) !== slug(p.id) && !mentions(g.instruction, name) && !mentions(g.instruction, firstName(name))) problems.push(`goal ${JSON.stringify(g.id)} of ${JSON.stringify(p.id)} depends on what ${name} did, so its instruction must call them ${firstName(name)}, the name they have in this plan`);
      }
    }
  }
  const personByName = new Map(people.map((p) => [firstName(p.name).toLowerCase(), p]));
  const productWords = new Set(product.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  for (const p of people) {
    for (const g of p.goals) {
      for (const [, actor] of g.instruction.matchAll(NAMED_ACTOR)) {
        const word = actor!.toLowerCase();
        if (CALENDAR.has(word) || NOT_PEOPLE.has(word) || productWords.has(word)) continue;
        const other = personByName.get(word);
        if (!other) problems.push(`goal ${JSON.stringify(g.id)} of ${JSON.stringify(p.id)} names ${actor}, who is not in this plan; refer to people only by the names in this plan`);
        else if (other !== p && !(g.needs ?? []).some((ref) => slug(ref.person) === slug(other.id))) problems.push(`goal ${JSON.stringify(g.id)} of ${JSON.stringify(p.id)} relies on what ${actor} did; list the goal of ${JSON.stringify(other.id)} it needs in its needs`);
      }
    }
  }
  const owned = people.flatMap((p) => p.goals.map((g) => ({ from: `${slug(p.id)}\0${slug(g.id)}`, personaId: slug(p.id), needs: g.needs })));
  if (dependencyOrder(owned) === null) problems.push("the goals' needs go round in a circle; a goal can only need goals that can come before it");
  return problems;
}

function planFrom(product: ProductPage, head: { name: string; description: string }, proposed: z.infer<typeof PersonProposal>[], playOrder: z.infer<typeof PlayOrder> = []): ProposedPlan {
  const people = uniqueIds(
    proposed.filter(usable).slice(0, MAX_PERSONAS).map((p) => ({ ...p, from: slug(p.id) })),
    "persona",
  );
  const personas = people.map((p) => ({ id: p.id, name: clip(p.name, 100), brief: clip(p.brief, 800) }));
  const owned = people.flatMap((p) => p.goals.filter((g) => g.instruction.trim()).slice(0, MAX_GOALS_PER_PERSONA).map((g) => ({ ...g, personaId: p.id, from: `${p.from}\0${slug(g.id)}` })));
  const played = inPlayOrder(owned, playOrder);
  const goals = uniqueIds(dependencyOrder(played) ?? played, "goal").map((g) => ({ id: g.id, instruction: clip(g.instruction, 300), personaId: g.personaId }));
  if (personas.length === 0) throw new SetupModelFailed("the setup model proposed no personas with goals");
  const project = ProjectConfigSchema.parse({
    name: clip(head.name, 100) || new URL(product.url).hostname,
    description: head.description,
    targetUrl: product.url,
    ...(product.docsUrl ? { docsUrl: product.docsUrl } : {}),
    allowedOrigins: product.docsUrl ? [product.docsUrl] : [],
    personas,
    goals,
    accounts: [],
  });
  return { project, signsIn: people.filter((p) => p.signsIn).map((p) => p.id) };
}

export async function proposePeople(opts: {
  model: LanguageModel;
  modelId: string;
  budget: Budget;
  product: ProductPage;
  name: string;
  description: string;
  features: string[];
  signUp?: SignUp;
}): Promise<ProposedPlan & { usage: JobUsage }> {
  const description = clip(opts.description, MAX_DESCRIPTION_CHARS);
  const features = opts.features.map((f) => clip(f, MAX_FEATURE_CHARS)).filter(Boolean).slice(0, MAX_CHOSEN_FEATURES);
  if (features.length === 0) throw new RangeError("choose at least one feature");
  const signUp = opts.signUp ?? "unclear";
  const { answer, usage } = await ask(opts, PeopleSchema, setupPrompt({ ...opts.product, context: { description, features, signUp } }), (a) => teamProblems(a, opts.name));
  const plan = planFrom(opts.product, { name: opts.name, description }, answer.personas, answer.playOrder ?? []);
  return { ...plan, signsIn: signUp === "closed" ? plan.project.personas.map((p) => p.id) : plan.signsIn, usage };
}

export async function proposeProject(opts: {
  model: LanguageModel;
  modelId: string;
  url: string;
  docsUrl?: string;
  focus?: string;
  budget: Budget;
  fetchText: (url: string) => Promise<string>;
}): Promise<{ project: ProjectConfig; usage: JobUsage }> {
  const focus = opts.focus?.trim() ? clip(opts.focus, MAX_FOCUS_CHARS) : undefined;
  if (opts.budget.exceeded) throw spent();
  const product = await readProduct(opts);
  const { answer, usage } = await ask(opts, ProposalSchema, setupPrompt({ ...product, focus }), (a) => teamProblems(a, a.name));
  return { project: planFrom(product, { name: answer.name, description: clip(answer.description, 600) }, answer.personas, answer.playOrder ?? []).project, usage };
}
