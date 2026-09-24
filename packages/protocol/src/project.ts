import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ }).refine((u) => { const url = new URL(u); return !url.username && !url.password; }, { message: "put credentials in accounts or httpCredentials, not in the URL" });

export const PersonaSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  brief: z.string().min(1),
  accountRef: z.string().min(1).optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const GoalSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  instruction: z.string().min(1),
});
export type Goal = z.infer<typeof GoalSchema>;

export const MIN_PASSWORD_LENGTH = 8;

export const TargetAccountSchema = z.strictObject({
  ref: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(MIN_PASSWORD_LENGTH),
});
export type TargetAccount = z.infer<typeof TargetAccountSchema>;

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

export const ProjectConfigSchema = z
  .strictObject({
    name: z.string().min(1),
    targetUrl: httpUrl,
    description: z.string().default(""),
    docsUrl: httpUrl.optional(),
    allowedOrigins: z.array(httpUrl.transform((u) => new URL(u).origin)).default([]),
    personas: z.array(PersonaSchema).min(1),
    goals: z.array(GoalSchema).min(1),
    accounts: z.array(TargetAccountSchema).default([]),
    httpCredentials: z.strictObject({ username: z.string().min(1), password: z.string().min(MIN_PASSWORD_LENGTH) }).optional(),
    extraHeaders: z.record(z.string(), z.string()).default({}),
    secretHeaders: z.record(z.string(), z.string().min(MIN_PASSWORD_LENGTH)).default({}),
  })
  .superRefine((p, ctx) => {
    for (const id of duplicates(p.goals.map((g) => g.id))) ctx.addIssue({ code: "custom", path: ["goals"], message: `duplicate goal id ${id}` });
    for (const id of duplicates(p.personas.map((x) => x.id))) ctx.addIssue({ code: "custom", path: ["personas"], message: `duplicate persona id ${id}` });
    for (const ref of duplicates(p.accounts.map((a) => a.ref))) ctx.addIssue({ code: "custom", path: ["accounts"], message: `duplicate account ref ${ref}` });
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
