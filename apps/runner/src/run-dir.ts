import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunEventSchema, type Finding, type JobUsage, type ReplayObservation, type RoleResult, type RunEvent, type RunEventInput, type Verdict } from "@usetrawler/protocol";

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
  verdicts: Record<string, Verdict>;
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

type Located = Finding & { persona: string };

function describe(f: Located, replay?: ReplayObservation): string {
  const steps = f.reproduction.map((step, i) => `${i + 1}. ${oneLine(step)}`).join("\n");
  const replayed = !replay
    ? ""
    : !replay.completed && replay.blockedAt === null
      ? "\n\nReplay: wrote no report."
      : `\n\nReplay: ${replay.completed ? "carried out every step" : `could not carry out step ${replay.blockedAt}`}. ${oneLine(replay.observed)}`;
  return `### ${oneLine(f.title)}\n${f.kind}, ${f.severity}, ${oneLine(f.persona)} / ${oneLine(f.goal)}\n\n${oneLine(f.observed)}\n\n${steps}${replayed}\n`;
}

export function renderReport(s: RunSummary): string {
  const findings: Located[] = s.roles.flatMap((r) => r.findings.map((f) => ({ ...f, persona: r.persona })));
  const section = (title: string, items: Located[]) =>
    items.length === 0 ? "" : `## ${title}\n\n${items.map((f) => describe(f, s.replays[f.id])).join("\n")}\n`;
  const defects = findings.filter((f) => f.kind === "defect");
  const by = (v: Verdict) => defects.filter((f) => s.verdicts[f.id] === v);
  const jobs = s.jobs.map((j) => `| ${j.jobId} | ${j.model} | ${j.steps} | ${usd(j.costUsd)} |`).join("\n");
  const goals = s.roles
    .map((r) => `**${r.persona}** (stopped by ${r.stoppedBy}${r.error ? `: ${oneLine(r.error)}` : ""})\n${r.goals.map((g) => `- ${g.goal}: ${g.status}${g.note ? ` — ${oneLine(g.note)}` : ""}`).join("\n")}`)
    .join("\n\n");
  const stopped = s.totalCostUsd >= s.budgetUsd ? ` The ${usd(s.budgetUsd)} budget ran out, so some jobs did not run.` : "";
  return `# ${oneLine(s.project)}

Agent model ${s.agentModel}, judge model ${s.judgeModel}. Total ${usd(s.totalCostUsd)} of ${usd(s.budgetUsd)}.${stopped}

| Job | Model | Steps | Cost |
|---|---|---|---|
${jobs}

## Goals

${goals}

${section("Confirmed defects", by("confirmed"))}${section("Inconclusive defects", by("inconclusive"))}${section("Refuted defects", by("refuted"))}${section("Defects not judged", defects.filter((f) => !s.verdicts[f.id]))}${section("Friction", findings.filter((f) => f.kind === "friction"))}`;
}
