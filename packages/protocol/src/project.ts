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
});
export type Goal = z.infer<typeof GoalSchema>;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PERSONAS = 12;
export const MAX_GOALS = 20;
export const MAX_ACCOUNTS = 20;

const HEADER_NAME = z.string().regex(/^[A-Za-z0-9-]{1,100}$/, "header names are letters, digits and dashes");
const HEADER_VALUE = z.string().max(4000).regex(/^[\t\x20-\x7e\x80-\xff]*$/, "header values are plain Latin-1 text without line breaks");
const MAX_ORIGINS = 20;

export const TargetAccountSchema = z.strictObject({
  ref: z.string().min(1).max(100),
  username: z.string().min(1).max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1000),
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
    docsUrl: httpUrl.optional(),
    allowedOrigins: z.array(httpUrl.transform((u) => new URL(u).origin)).max(MAX_ORIGINS).default([]),
    personas: z.array(PersonaSchema).min(1).max(MAX_PERSONAS),
    goals: z.array(GoalSchema).min(1).max(MAX_GOALS),
    accounts: z.array(TargetAccountSchema).max(MAX_ACCOUNTS).default([]),
    httpCredentials: z.strictObject({ username: z.string().min(1).max(320).regex(/^[\x20-\x39\x3b-\x7e\x80-\xff]+$/, "basic auth usernames are plain Latin-1 text without colons"), password: z.string().min(MIN_PASSWORD_LENGTH).max(1000) }).optional(),
    extraHeaders: z.record(HEADER_NAME, HEADER_VALUE).default({}),
    secretHeaders: z.record(HEADER_NAME, HEADER_VALUE.min(MIN_PASSWORD_LENGTH)).default({}),
  })
  .superRefine((p, ctx) => {
    for (const id of duplicates(p.goals.map((g) => g.id))) ctx.addIssue({ code: "custom", path: ["goals"], message: `duplicate goal id ${id}` });
    for (const id of duplicates(p.personas.map((x) => x.id))) ctx.addIssue({ code: "custom", path: ["personas"], message: `duplicate persona id ${id}` });
    const target = URL.canParse(p.targetUrl) ? new URL(p.targetUrl).origin : p.targetUrl;
    if (new Set([target, ...p.allowedOrigins]).size > MAX_ORIGINS) ctx.addIssue({ code: "custom", path: ["allowedOrigins"], message: `at most ${MAX_ORIGINS} origins including the target` });
    for (const ref of duplicates(p.accounts.map((a) => a.ref))) ctx.addIssue({ code: "custom", path: ["accounts"], message: `duplicate account ref ${ref}` });
    for (const name of duplicates([...Object.keys(p.extraHeaders), ...Object.keys(p.secretHeaders)].map((h) => h.toLowerCase()))) ctx.addIssue({ code: "custom", path: ["extraHeaders"], message: `header ${name} is set more than once` });
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
