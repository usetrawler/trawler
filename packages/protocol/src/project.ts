import { z } from "zod";

export const PersonaSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  brief: z.string().min(1),
  accountRef: z.string().optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const GoalSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  instruction: z.string().min(1),
});
export type Goal = z.infer<typeof GoalSchema>;

export const TargetAccountSchema = z.object({
  ref: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});
export type TargetAccount = z.infer<typeof TargetAccountSchema>;

function duplicates(ids: string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

export const ProjectConfigSchema = z
  .object({
    name: z.string().min(1),
    targetUrl: z.url(),
    description: z.string().default(""),
    docsUrl: z.url().optional(),
    allowedOrigins: z.array(z.url()).min(1),
    personas: z.array(PersonaSchema).min(1),
    goals: z.array(GoalSchema).min(1),
    accounts: z.array(TargetAccountSchema).default([]),
    httpCredentials: z.object({ username: z.string(), password: z.string() }).optional(),
    extraHeaders: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((p, ctx) => {
    for (const id of duplicates(p.goals.map((g) => g.id))) ctx.addIssue({ code: "custom", message: `duplicate goal id ${id}` });
    for (const id of duplicates(p.personas.map((x) => x.id))) ctx.addIssue({ code: "custom", message: `duplicate persona id ${id}` });
    const refs = new Set(p.accounts.map((a) => a.ref));
    for (const persona of p.personas) {
      if (persona.accountRef && !refs.has(persona.accountRef)) {
        ctx.addIssue({ code: "custom", message: `persona ${persona.id} points at unknown account ${persona.accountRef}` });
      }
    }
  });
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
