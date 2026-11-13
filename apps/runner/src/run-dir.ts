import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunEventSchema, type Finding, type Goal, type JobUsage, type ReplayObservation, type RoleResult, type RunEvent, type RunEventInput, type Verdict } from "@usetrawler/protocol";

export interface RunSummary {
  project: string;
  agentModel: string;
  judgeModel: string;
  startedAt: string;
  finishedAt: string;
  budgetUsd: number;
  totalCostUsd: number;
  jobs: Array<{ jobId: string } & JobUsage>;
  roles: RoleResult[];
  replays: Record<string, ReplayObservation>;
  replayErrors: Record<string, string>;
  verdicts: Record<string, Verdict>;
  judgeErrors: Record<string, string>;
  refusedAccount?: string;
  people?: Record<string, string>;
  browserFailures?: Array<{ jobId: string; url: string; cause: string }>;
  secondRound?: { goals: Goal[]; passedBy: string[]; error?: string };
}

export class RunDir {
  #seq = 0;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }
  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }
  emit(e: RunEventInput): RunEvent {
    const event = RunEventSchema.parse({ ...e, seq: this.#seq + 1, at: new Date().toISOString() });
    this.#seq += 1;
    appendFileSync(this.path("events.jsonl"), `${JSON.stringify(event)}\n`);
    return event;
  }
  writeSummary(s: RunSummary): void {
    writeFileSync(this.path("summary.json"), `${JSON.stringify(s, null, 2)}\n`);
  }
  writeReport(markdown: string): void {
    writeFileSync(this.path("report.md"), markdown);
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function readable(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

type Located = Finding & { persona: string };

function originOf(url: string): string {
  try {
    return new URL(url.replace(/^ws(s?):/, "http$1:")).origin;
  } catch {
    return url;
  }
}

function browserFailures(failures: NonNullable<RunSummary["browserFailures"]>): string {
  if (failures.length === 0) return "";
  const byOriginAndCause = new Map<string, Set<string>>();
  for (const f of failures) {
    const key = `${originOf(f.url)}: ${f.cause}`;
    byOriginAndCause.set(key, (byOriginAndCause.get(key) ?? new Set()).add(f.jobId));
  }
  const lines = [...byOriginAndCause].map(([key, jobs]) => `- ${key} (${[...jobs].join(", ")})`).join("\n");
  return `\n## The browser could not load\n\nThe browser itself failed or blocked these requests, so parts of the product may not have worked during the run. Errors like these often come from where the product runs rather than from the product itself: check findings about missing or broken parts against this list before acting on them.\n\n${lines}\n`;
}

function secondRound(round: RunSummary["secondRound"], people: Record<string, string>): string {
  if (!round) return "";
  if (round.error) return `\n## Second round\n\nNot played: ${oneLine(round.error)}\n`;
  const passedBy = round.passedBy.length > 0 ? `What the first round passed by:\n\n${round.passedBy.map((p) => `- ${oneLine(p)}`).join("\n")}\n\n` : "";
  const goals = round.goals.map((g) => `- ${g.id} (${oneLine(people[g.personaId ?? ""] ?? g.personaId ?? "everyone")}): ${oneLine(g.instruction)}`).join("\n");
  return `\n## Second round\n\nGoals written after the first round, from the pages the people saw, to try what they walked past.\n\n${passedBy}${goals}\n`;
}

function describe(f: Located, people: Record<string, string>, later: Set<string>, replay?: ReplayObservation, replayError?: string, judgeError?: string): string {
  const who = (i: number) => (f.by && f.by.length === f.reproduction.length ? `${oneLine(people[f.by[i]!] ?? f.by[i]!)}: ` : "");
  const steps = f.reproduction.map((step, i) => `${i + 1}. ${who(i)}${oneLine(step)}`).join("\n");
  const replayed = replayError
    ? `\n\nReplay: failed to run. ${oneLine(replayError)}`
    : !replay
    ? ""
    : !replay.completed && replay.blockedAt === null
      ? "\n\nReplay: wrote no report."
      : `\n\nReplay: ${replay.completed ? "carried out every step" : `could not carry out step ${replay.blockedAt}`}. ${oneLine(replay.observed)}`;
  const judged = judgeError ? `\n\nJudge: could not be judged. ${oneLine(judgeError)}` : "";
  const page = f.url ? `\nPage: ${readable(f.url)}` : "";
  const said = f.quote ? `\n\n> ${oneLine(f.quote)}` : "";
  return `### ${oneLine(f.title)}\n${f.kind}, ${f.severity}, ${oneLine(f.persona)} / ${oneLine(f.goal)}${later.has(f.goal) ? ", second round" : ""}${page}\n\n${oneLine(f.observed)}${said}\n\n${steps}${replayed}${judged}\n`;
}

export function renderReport(s: RunSummary): string {
  const findings: Located[] = s.roles.flatMap((r) => r.findings.map((f) => ({ ...f, persona: r.persona })));
  const later = new Set((s.secondRound?.goals ?? []).map((g) => g.id));
  const section = (title: string, items: Located[]) =>
    items.length === 0 ? "" : `## ${title}\n\n${items.map((f) => describe(f, s.people ?? {}, later, s.replays[f.id], s.replayErrors[f.id], s.judgeErrors[f.id])).join("\n")}\n`;
  const defects = findings.filter((f) => f.kind === "defect");
  const by = (v: Verdict) => defects.filter((f) => s.verdicts[f.id] === v);
  const jobs = s.jobs.map((j) => `| ${j.jobId} | ${j.model} | ${j.steps} | ${usd(j.costUsd)} |`).join("\n");
  const goals = s.roles
    .map((r) => `**${r.persona}** (stopped by ${r.stoppedBy}${r.error ? `: ${oneLine(r.error)}` : ""})\n${r.goals.map((g) => `- ${g.goal}${later.has(g.goal) ? " (second round)" : ""}: ${g.status}${g.note ? ` — ${oneLine(g.note)}` : ""}`).join("\n")}`)
    .join("\n\n");
  const stopped = s.totalCostUsd >= s.budgetUsd ? ` The ${usd(s.budgetUsd)} budget ran out, so some jobs did not run.` : "";
  return `# ${oneLine(s.project)}

Agent model ${s.agentModel}, judge model ${s.judgeModel}. Total ${usd(s.totalCostUsd)} of ${usd(s.budgetUsd)}.${stopped}
${s.refusedAccount ? `\n**Stopped before anyone started:** ${oneLine(s.refusedAccount)} Check that account in the project file and run again.\n` : ""}
| Job | Model | Steps | Cost |
|---|---|---|---|
${jobs}
${browserFailures(s.browserFailures ?? [])}${secondRound(s.secondRound, s.people ?? {})}
## Goals

${goals}

${section("Confirmed defects", by("confirmed"))}${section("Inconclusive defects", by("inconclusive"))}${section("Refuted defects", by("refuted"))}${section("Defects not judged", defects.filter((f) => !s.verdicts[f.id]))}${section("Friction", findings.filter((f) => f.kind === "friction"))}`;
}
