import { tool } from "ai";
import { z } from "zod";
import { FindingSchema, type Finding, type Goal, type GoalOutcome, type RunEventInput, type TargetAccount } from "@usetrawler/protocol";
import type { SecretScrubber } from "./secrets.ts";

export interface SessionState {
  notes: string[];
  findings: Finding[];
  goals: Map<string, GoalOutcome>;
  finished: string | null;
}

export type FieldKind = "username" | "password";
export type FillField = (ref: string, text: string, kind: FieldKind) => Promise<string>;

export function newSessionState(goals: Goal[]): SessionState {
  return {
    notes: [],
    findings: [],
    goals: new Map(goals.map((g) => [g.id, { goal: g.id, status: "not_attempted", note: "" }])),
    finished: null,
  };
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

function steps(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.split("\n").map((s) => s.replace(/^\s*(\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean);
}

export function sessionTools(opts: {
  state: SessionState;
  accounts: TargetAccount[];
  emit: (e: RunEventInput) => void;
  jobId: string;
  fillField: FillField;
  scrubber: SecretScrubber;
  newId: () => string;
}) {
  const { state, emit, jobId } = opts;
  const goalIds = () => [...state.goals.keys()];
  const unknownGoal = (goal: string) => `rejected: unknown goal ${goal}; use one of ${goalIds().join(", ")}`;

  return {
    note: tool({
      description: "Add a line to your scratchpad. The scratchpad stays in view for the whole session; old page snapshots do not.",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        if (!text.trim()) return "rejected: text: the note is empty";
        emit({ type: "note", jobId, text });
        state.notes.push(text);
        return "noted";
      },
    }),
    submit_finding: tool({
      description:
        "Record a defect or a friction the moment you have seen it. kind: defect | friction. severity: low | medium | high. reproduction: the literal steps, one per array item; a defect needs at least two.",
      inputSchema: z.object({
        kind: z.string(),
        goal: z.string(),
        title: z.string(),
        observed: z.string(),
        reproduction: z.union([z.array(z.string()), z.string()]),
        severity: z.string(),
      }),
      execute: async (input) => {
        if (!state.goals.has(input.goal)) return unknownGoal(input.goal);
        const parsed = FindingSchema.safeParse({ ...input, reproduction: steps(input.reproduction), id: "pending" });
        if (!parsed.success) return `rejected: ${issues(parsed.error)}`;
        const duplicate = state.findings.find((f) => f.goal === parsed.data.goal && f.kind === parsed.data.kind && f.title.toLowerCase() === parsed.data.title.toLowerCase());
        if (duplicate) return `rejected: already recorded as ${duplicate.id}`;
        const finding = { ...parsed.data, id: opts.newId() };
        emit({ type: "finding", jobId, finding });
        state.findings.push(finding);
        return `recorded ${finding.id}`;
      },
    }),
    goal_status: tool({
      description: "Record where a goal ended up: reached, or failed with where you stopped. A later call for the same goal replaces the earlier one.",
      inputSchema: z.object({ goal: z.string(), status: z.string(), note: z.string() }),
      execute: async ({ goal, status, note }) => {
        if (!state.goals.has(goal)) return unknownGoal(goal);
        if (status !== "reached" && status !== "failed") return `rejected: status: use reached or failed`;
        const outcome = { goal, status, note } as const;
        emit({ type: "goal_status", jobId, outcome });
        state.goals.set(goal, outcome);
        return "recorded";
      },
    }),
    sign_in: tool({
      description: "Type a stored account's username and password into two fields, by their snapshot refs. You never see the password.",
      inputSchema: z.object({ account: z.string(), usernameField: z.string(), passwordField: z.string() }),
      execute: async ({ account, usernameField, passwordField }) => {
        const a = opts.accounts.find((x) => x.ref === account);
        if (!a) return `rejected: unknown account ${account}; known: ${opts.accounts.map((x) => x.ref).join(", ") || "none"}`;
        opts.scrubber.add(a.password);
        try {
          await opts.fillField(usernameField, a.username, "username");
          return opts.scrubber.scrub(await opts.fillField(passwordField, a.password, "password"));
        } catch (err) {
          return opts.scrubber.scrub(`failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),
    finish: tool({
      description: "End the session with a short summary once every goal has a status (reached or failed).",
      inputSchema: z.object({ summary: z.string() }),
      execute: async ({ summary }) => {
        if (!summary.trim()) return "rejected: summary: write a short summary";
        const open = [...state.goals.values()].filter((g) => g.status === "not_attempted").map((g) => g.goal);
        if (open.length) return `rejected: give these goals a status first (goal_status reached or failed): ${open.join(", ")}`;
        state.finished = summary;
        return "finished";
      },
    }),
  };
}

export type SessionTools = ReturnType<typeof sessionTools>;
