import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ }).max(2048).refine((u) => { try { const url = new URL(u); return !url.username && !url.password; } catch { return true; } }, { message: "put credentials in accounts or httpCredentials, not in the URL" });

export const PersonaSchema = z.strictObject({
  id: z.string().max(60).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  brief: z.string().min(1).max(2000),
  accountRef: z.string().min(1).max(100).optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const GoalSchema = z.strictObject({
  id: z.string().max(60).regex(/^[a-z0-9-]+$/),
  instruction: z.string().min(1).max(1000),
  personaId: z.string().max(60).regex(/^[a-z0-9-]+$/).optional(),
});
export type Goal = z.infer<typeof GoalSchema>;

export function goalsFor<G extends { personaId?: string }>(goals: G[], personaId: string): G[] {
  return goals.filter((g) => g.personaId === undefined || g.personaId === personaId);
}

export interface Turn {
  personaId: string;
  goalIds: string[];
}

export function turnsOf(config: { personas: { id: string }[]; goals: { id: string; personaId?: string }[] }): Turn[] {
  if (config.goals.some((g) => g.personaId === undefined)) {
    return config.personas.map((p) => ({ personaId: p.id, goalIds: goalsFor(config.goals, p.id).map((g) => g.id) }));
  }
  const turns: Turn[] = [];
  for (const goal of config.goals) {
    const last = turns.at(-1);
    if (last && last.personaId === goal.personaId) last.goalIds.push(goal.id);
    else turns.push({ personaId: goal.personaId!, goalIds: [goal.id] });
  }
  return turns;
}

export const MIN_SECRET_HEADER_LENGTH = 8;
export const MAX_PERSONAS = 12;
export const MAX_GOALS_PER_PERSONA = 20;
export const MAX_GOALS = MAX_PERSONAS * MAX_GOALS_PER_PERSONA;
export const MAX_ACCOUNTS = 20;
export const MAX_BRIEF = 1200;
export const MAX_SECRET_HEADERS = 20;

const HEADER_NAME = z.string().regex(/^[A-Za-z0-9-]{1,100}$/, "header names are letters, digits and dashes");
const HEADER_VALUE = z.string().max(4000).regex(/^[\t\x20-\x7e\x80-\xff]*$/, "header values are plain Latin-1 text without line breaks");
const MAX_ORIGINS = 20;

export const TargetAccountSchema = z.strictObject({
  ref: z.string().min(1).max(100),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1000),
});
export type TargetAccount = z.infer<typeof TargetAccountSchema>;

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

export const ProjectConfigSchema = z
  .strictObject({
    name: z.string().min(1).max(200),
    targetUrl: httpUrl,
    description: z.string().max(2000).default(""),
    brief: z.string().max(MAX_BRIEF).optional(),
    docsUrl: httpUrl.optional(),
    allowedOrigins: z.array(httpUrl.transform((u) => new URL(u).origin)).max(MAX_ORIGINS).default([]),
    personas: z.array(PersonaSchema).min(1).max(MAX_PERSONAS),
    goals: z.array(GoalSchema).min(1).max(MAX_GOALS),
    accounts: z.array(TargetAccountSchema).max(MAX_ACCOUNTS).default([]),
    httpCredentials: z.strictObject({ username: z.string().min(1).max(320).regex(/^[\x20-\x39\x3b-\x7e\x80-\xff]+$/, "basic auth usernames are plain Latin-1 text without colons"), password: z.string().min(1).max(1000) }).optional(),
    extraHeaders: z.record(HEADER_NAME, HEADER_VALUE).default({}),
    secretHeaders: z.record(HEADER_NAME, HEADER_VALUE.min(MIN_SECRET_HEADER_LENGTH)).refine((headers) => Object.keys(headers).length <= MAX_SECRET_HEADERS, `at most ${MAX_SECRET_HEADERS} secret headers`).default({}),
  })
  .superRefine((p, ctx) => {
    for (const id of duplicates(p.goals.map((g) => g.id))) ctx.addIssue({ code: "custom", path: ["goals"], message: `duplicate goal id ${id}` });
    for (const id of duplicates(p.personas.map((x) => x.id))) ctx.addIssue({ code: "custom", path: ["personas"], message: `duplicate persona id ${id}` });
    const target = URL.canParse(p.targetUrl) ? new URL(p.targetUrl).origin : p.targetUrl;
    if (new Set([target, ...p.allowedOrigins]).size > MAX_ORIGINS) ctx.addIssue({ code: "custom", path: ["allowedOrigins"], message: `at most ${MAX_ORIGINS} origins including the target` });
    for (const ref of duplicates(p.accounts.map((a) => a.ref))) ctx.addIssue({ code: "custom", path: ["accounts"], message: `duplicate account ref ${ref}` });
    for (const name of duplicates([...Object.keys(p.extraHeaders), ...Object.keys(p.secretHeaders)].map((h) => h.toLowerCase()))) ctx.addIssue({ code: "custom", path: ["extraHeaders"], message: `header ${name} is set more than once` });
    const personaIds = new Set(p.personas.map((x) => x.id));
    p.goals.forEach((goal, i) => {
      if (goal.personaId !== undefined && !personaIds.has(goal.personaId)) {
        ctx.addIssue({ code: "custom", path: ["goals", i, "personaId"], message: `goal ${goal.id} belongs to unknown persona ${goal.personaId}` });
      }
    });
    p.personas.forEach((persona, i) => {
      const own = goalsFor(p.goals, persona.id).length;
      if (own === 0) ctx.addIssue({ code: "custom", path: ["personas", i], message: `persona ${persona.id} has no goals` });
      if (own > MAX_GOALS_PER_PERSONA) ctx.addIssue({ code: "custom", path: ["personas", i], message: `persona ${persona.id} has more than ${MAX_GOALS_PER_PERSONA} goals` });
    });
    const refs = new Set(p.accounts.map((a) => a.ref));
    p.personas.forEach((persona, i) => {
      if (persona.accountRef !== undefined && !refs.has(persona.accountRef)) {
        ctx.addIssue({ code: "custom", path: ["personas", i, "accountRef"], message: `persona ${persona.id} points at unknown account ${persona.accountRef}` });
      }
    });
  })
  .transform((p) => ({ ...p, allowedOrigins: [...new Set([new URL(p.targetUrl).origin, ...p.allowedOrigins])] }));
export type ProjectConfig = z.output<typeof ProjectConfigSchema>;
export type ProjectConfigInput = z.input<typeof ProjectConfigSchema>;
