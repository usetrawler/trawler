import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { ProjectConfigSchema, type JobUsage, type ProjectConfig } from "@usetrawler/protocol";
import { type Budget, tallyStep } from "./llm.ts";
import { setupPrompt } from "./prompts.ts";

const MAX_PERSONAS = 4;
const MAX_GOALS = 6;
const PAGE_CHARS = 12_000;
const DOCS_CHARS = 8_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function pageText(html: string, maxChars: number): string {
  const description = /<meta\s[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? "";
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(`${description ? `${description} ` : ""}${text}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function httpAddress(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RangeError(`only plain http(s) addresses can be set up, got ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new RangeError(`only plain http(s) addresses can be set up, got ${url}`);
  return parsed.href;
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function uniqueIds<T extends { id: string }>(items: T[], fallback: string): T[] {
  const seen = new Set<string>();
  return items.map((item, i) => {
    const base = slug(item.id) || `${fallback}-${i + 1}`;
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
  budget: Budget;
  fetchText: (url: string) => Promise<string>;
}): Promise<{ project: ProjectConfig; usage: JobUsage }> {
  const url = httpAddress(opts.url);
  const docsUrl = opts.docsUrl === undefined ? undefined : httpAddress(opts.docsUrl);
  if (opts.budget.exceeded) throw new Error("the budget is already spent, so no project was proposed");
  let page: string;
  try {
    page = pageText(await opts.fetchText(url), PAGE_CHARS);
  } catch (err) {
    throw new Error(`could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const docs = docsUrl ? await opts.fetchText(docsUrl).then((html) => pageText(html, DOCS_CHARS), () => undefined) : undefined;

  const usage: JobUsage = { model: opts.modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
  let proposal: z.infer<typeof ProposalSchema>;
  try {
    ({ output: proposal } = await generateText({
      model: opts.model,
      output: Output.object({ schema: ProposalSchema }),
      prompt: setupPrompt({ url, page, docs }),
      onStepEnd: (step) => void tallyStep(usage, opts.budget, step),
    }));
  } catch (err) {
    throw new Error(`the setup model could not propose a project: ${err instanceof Error ? err.message : String(err)}`);
  }
  const personas = uniqueIds(proposal.personas.filter((p) => p.name.trim() && p.brief.trim()).slice(0, MAX_PERSONAS), "persona")
    .map((p) => ({ id: p.id, name: p.name.trim(), brief: p.brief.trim() }));
  const goals = uniqueIds(proposal.goals.filter((g) => g.instruction.trim()).slice(0, MAX_GOALS), "goal")
    .map((g) => ({ id: g.id, instruction: g.instruction.trim() }));
  if (personas.length === 0) throw new Error("the setup model proposed no personas");
  if (goals.length === 0) throw new Error("the setup model proposed no goals");

  const project = ProjectConfigSchema.parse({
    name: proposal.name.trim() || new URL(url).hostname,
    description: proposal.description.trim(),
    targetUrl: url,
    ...(docsUrl ? { docsUrl } : {}),
    allowedOrigins: docsUrl ? [docsUrl] : [],
    personas,
    goals,
    accounts: [],
  });
  return { project, usage };
}
