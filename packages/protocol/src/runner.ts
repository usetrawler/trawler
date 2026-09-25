import { z } from "zod";
import { JobStopReasonSchema, JobUsageSchema, RunEventSchema } from "./event.ts";
import { FindingSchema, ReplayObservationSchema } from "./finding.ts";
import { ProjectConfigSchema } from "./project.ts";

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = "x-trawler-protocol";
export const MAX_EVENTS_PER_BATCH = 200;

export const JobKindSchema = z.enum(["role_session", "replay", "judge"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobAssignmentSchema = z.object({
  jobId: z.uuid(),
  runId: z.uuid(),
  token: z.string().min(32),
  kind: JobKindSchema,
  config: ProjectConfigSchema,
  personaKey: z.string().optional(),
  accountRef: z.string().optional(),
  finding: FindingSchema.optional(),
  observation: ReplayObservationSchema.optional(),
  maxSteps: z.number().int().positive(),
  budgetUsd: z.number().nonnegative(),
  agentModel: z.string().min(1),
  judgeModel: z.string().min(1),
});
export type JobAssignment = z.infer<typeof JobAssignmentSchema>;

export const EventBatchSchema = z.object({ events: z.array(RunEventSchema).max(MAX_EVENTS_PER_BATCH) });
export type EventBatch = z.infer<typeof EventBatchSchema>;

export const EventsAcceptedSchema = z.object({ cancel: z.boolean() });

export const JobCompletionSchema = z.object({
  usage: JobUsageSchema,
  stoppedBy: JobStopReasonSchema,
  error: z.string().max(2000).optional(),
  observation: ReplayObservationSchema.optional(),
});
export type JobCompletion = z.infer<typeof JobCompletionSchema>;
