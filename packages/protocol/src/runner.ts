import { z } from "zod";
import { JobStopReasonSchema, JobUsageSchema, RunEventSchema } from "./event.ts";
import { FindingSchema, ReplayObservationSchema } from "./finding.ts";
import { ProjectConfigSchema } from "./project.ts";

export const PROTOCOL_VERSION = 3;
export const PROTOCOL_HEADER = "x-trawler-protocol";
export const MAX_EVENTS_PER_BATCH = 200;
export const JOB_STOPPED = "job_stopped";
export const ANSWER_UNUSABLE = "answer_unusable";

export const JobKindSchema = z.enum(["account_check", "role_session", "replay", "judge"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const MAX_STORY = 60;
export const MAX_STORY_ENTRY = 500;
export const MAX_STORY_CHARS = 12_000;

export function trimStory<E extends { text: string; goal?: string }>(story: E[]): E[] {
  const kept: E[] = [];
  let chars = 0;
  for (const entry of story.slice(-MAX_STORY).reverse()) {
    const text = entry.text.length > MAX_STORY_ENTRY ? `${entry.text.slice(0, MAX_STORY_ENTRY - 1)}…` : entry.text;
    chars += text.length + (entry.goal?.length ?? 0);
    if (chars > MAX_STORY_CHARS) break;
    kept.unshift({ ...entry, text });
  }
  return kept;
}

export const StoryEntrySchema = z.object({
  personaId: z.string(),
  name: z.string(),
  goal: z.string().optional(),
  status: z.enum(["reached", "failed"]).optional(),
  text: z.string().max(4000),
});
export type StoryEntry = z.infer<typeof StoryEntrySchema>;

export const JobAssignmentSchema = z.object({
  jobId: z.uuid(),
  runId: z.uuid(),
  token: z.string().min(32),
  kind: JobKindSchema,
  config: ProjectConfigSchema,
  personaKey: z.string().optional(),
  goalIds: z.array(z.string()).optional(),
  turn: z.number().int().nonnegative().optional(),
  returning: z.boolean().optional(),
  story: z.array(StoryEntrySchema).max(MAX_STORY).optional(),
  signUpSeed: z.string().max(200).optional(),
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

export const ACCOUNT_CHECK_STEPS = 12;

export const SignInCheckSchema = z.object({
  outcome: z.enum(["signed_in", "refused", "unclear"]),
  observed: z.string().max(1000),
});
export type SignInCheck = z.infer<typeof SignInCheckSchema>;

export const JobCompletionSchema = z.object({
  usage: JobUsageSchema,
  stoppedBy: JobStopReasonSchema,
  error: z.string().max(2000).optional(),
  observation: ReplayObservationSchema.optional(),
  signIn: SignInCheckSchema.optional(),
});
export type JobCompletion = z.infer<typeof JobCompletionSchema>;
