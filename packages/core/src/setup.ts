import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { ProjectConfigSchema, type JobUsage, type ProjectConfig } from "@usetrawler/protocol";
import { type Budget, tallyStep } from "./llm.ts";
import { setupPrompt } from "./prompts.ts";

const MAX_PERSONAS = 4;
const MAX_GOALS = 6;
const PAGE_CHARS = 12_000;
const DOCS_CHARS = 8_000;
const MAX_FOCUS_CHARS = 500;
const SETUP_OUTPUT_TOKENS = 4_000;

const MAX_HTML_CHARS = 2_000_000;
const MAX_TAG_CHARS = 5_000;
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
  const limit = Math.min(html.length, from + MAX_TAG_CHARS);
  for (let i = from; i < limit; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
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
      const close = html.indexOf("-->", lt + 4);
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
      const closer = new RegExp(`</${name}\\b`, "ig");
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

const ProposalSchema = z.object({
  name: z.string(),
  description: z.string(),
  personas: z.array(z.object({ id: z.string(), name: z.string(), brief: z.string() })),
  goals: z.array(z.object({ id: z.string(), instruction: z.string() })),
});

export async function proposeProject(opts: {
  model: LanguageModel;
  modelId: string;
  url: string;
  docsUrl?: string;
  focus?: string;
  budget: Budget;
  fetchText: (url: string) => Promise<string>;
}): Promise<{ project: ProjectConfig; usage: JobUsage }> {
  const url = httpAddress(opts.url);
  const docsUrl = opts.docsUrl?.trim() ? httpAddress(opts.docsUrl.trim()) : undefined;
  const focus = opts.focus?.trim() ? clip(opts.focus, MAX_FOCUS_CHARS) : undefined;
  const spent = () => new Error("the budget is already spent, so no project was proposed");
  if (opts.budget.exceeded) throw spent();
  const [pageRead, docsRead] = await Promise.allSettled([opts.fetchText(url), docsUrl ? opts.fetchText(docsUrl) : Promise.resolve(undefined)]);
  if (pageRead.status === "rejected") {
    const reason = pageRead.reason instanceof Error ? pageRead.reason.message : String(pageRead.reason);
    throw new Error(`could not read ${url}: ${reason}`);
  }
  const page = pageText(pageRead.value, PAGE_CHARS);
  const docs = docsRead.status === "fulfilled" && docsRead.value !== undefined ? pageText(docsRead.value, DOCS_CHARS) : undefined;
  if (opts.budget.exceeded) throw spent();

  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
  let proposal: z.infer<typeof ProposalSchema>;
  try {
    ({ output: proposal } = await generateText({
      model: opts.model,
      output: Output.object({ schema: ProposalSchema }),
      prompt: setupPrompt({ url, page, docs, focus }),
      maxOutputTokens: SETUP_OUTPUT_TOKENS,
      onStepEnd: (step) => void tallyStep(usage, opts.budget, step),
    }));
  } catch (err) {
    throw new Error(`the setup model could not propose a project: ${err instanceof Error ? err.message : String(err)}`);
  }
  const personas = uniqueIds(proposal.personas.filter((p) => p.name.trim() && p.brief.trim()).slice(0, MAX_PERSONAS), "persona")
    .map((p) => ({ id: p.id, name: clip(p.name, 100), brief: clip(p.brief, 800) }));
  const goals = uniqueIds(proposal.goals.filter((g) => g.instruction.trim()).slice(0, MAX_GOALS), "goal")
    .map((g) => ({ id: g.id, instruction: clip(g.instruction, 300) }));
  if (personas.length === 0) throw new Error("the setup model proposed no personas");
  if (goals.length === 0) throw new Error("the setup model proposed no goals");

  const project = ProjectConfigSchema.parse({
    name: clip(proposal.name, 100) || new URL(url).hostname,
    description: clip(proposal.description, 600),
    targetUrl: url,
    ...(docsUrl ? { docsUrl } : {}),
    allowedOrigins: docsUrl ? [docsUrl] : [],
    personas,
    goals,
    accounts: [],
  });
  return { project, usage };
}
