import { z } from "zod";
import { FindingSchema, GoalOutcomeSchema, StopReasonSchema, VerdictSchema } from "./finding.ts";

export const JobUsageSchema = z.object({
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().max(10_000),
  steps: z.number().int().nonnegative(),
});
export type JobUsage = z.infer<typeof JobUsageSchema>;

export const JobStopReasonSchema = z.union([StopReasonSchema, z.enum(["report", "no_report", "done"])]);
export type JobStopReason = z.infer<typeof JobStopReasonSchema>;

const base = { seq: z.number().int().positive().max(2_147_483_647), at: z.iso.datetime(), jobId: z.string().min(1) };

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("job_started"), kind: z.enum(["role_session", "replay", "judge", "setup"]) }),
  z.object({ ...base, type: z.literal("step"), step: z.number().int().positive(), tool: z.string().max(100).nullable(), costUsd: z.number().nonnegative().max(1000) }),
  z.object({ ...base, type: z.literal("note"), text: z.string() }),
  z.object({ ...base, type: z.literal("finding"), finding: FindingSchema }),
  z.object({ ...base, type: z.literal("goal_status"), outcome: GoalOutcomeSchema }),
  z.object({ ...base, type: z.literal("blocked_request"), url: z.string() }),
  z.object({ ...base, type: z.literal("verdict"), findingId: z.string().min(1), verdict: VerdictSchema, observed: z.string() }),
  z.object({ ...base, type: z.literal("job_finished"), usage: JobUsageSchema, stoppedBy: JobStopReasonSchema, error: z.string().optional() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventInput = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "seq" | "at"> : never) : never;
