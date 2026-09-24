import { z } from "zod";

export const FindingSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["defect", "friction"]),
    goal: z.string().min(1),
    title: z.string().trim().min(1),
    observed: z.string().trim().min(1),
    reproduction: z.array(z.string().trim().min(1)).min(1),
    severity: z.enum(["low", "medium", "high"]),
  })
  .refine((f) => f.kind !== "defect" || f.reproduction.length >= 2, {
    message: "a defect needs at least two reproduction steps",
    path: ["reproduction"],
  });
export type Finding = z.infer<typeof FindingSchema>;

export const GoalOutcomeSchema = z.object({
  goal: z.string().min(1),
  status: z.enum(["reached", "failed", "not_attempted"]),
  note: z.string(),
});
export type GoalOutcome = z.infer<typeof GoalOutcomeSchema>;

export const StopReasonSchema = z.enum(["finish", "max_steps", "budget", "error"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const RoleResultSchema = z.object({
  persona: z.string().min(1),
  goals: z.array(GoalOutcomeSchema),
  findings: z.array(FindingSchema),
  stoppedBy: StopReasonSchema,
});
export type RoleResult = z.infer<typeof RoleResultSchema>;

export const VerdictSchema = z.enum(["confirmed", "refuted", "inconclusive"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ReplayObservationSchema = z.object({
  completed: z.boolean(),
  observed: z.string(),
  blockedAt: z.number().int().positive().nullable(),
});
export type ReplayObservation = z.infer<typeof ReplayObservationSchema>;
