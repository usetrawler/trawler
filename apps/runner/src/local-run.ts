import type { LanguageModel } from "ai";
import { Budget, judge, runReplay, runRoleSession, SecretScrubber, type Browser } from "@usetrawler/core";
import type { ProjectConfig, RoleResult, RunEventInput } from "@usetrawler/protocol";
import type { RunSummary } from "./run-dir.ts";

const CLOSE_TIMEOUT_MS = 10_000;

export type OpenBrowser = (opts: { onBlocked: (url: string) => void; scrubber: SecretScrubber }) => Promise<Browser>;

export async function localRun(opts: {
  project: ProjectConfig;
  agentModel: LanguageModel;
  agentModelId: string;
  judgeModel: LanguageModel;
  judgeModelId: string;
  budgetUsd: number;
  maxSteps: number;
  replaySteps: number;
  emit: (e: RunEventInput) => void;
  openBrowser: OpenBrowser;
}): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const budget = new Budget(opts.budgetUsd);
  const summary: RunSummary = {
    project: opts.project.name, agentModel: opts.agentModelId, judgeModel: opts.judgeModelId,
    startedAt, finishedAt: startedAt, budgetUsd: opts.budgetUsd, totalCostUsd: 0, jobs: [], roles: [], replays: {}, replayErrors: {}, verdicts: {},
  };
  const scrubberFor = () => SecretScrubber.forProject(opts.project);
  let findingNo = 0;

  const withBrowser = async <T>(jobId: string, scrubber: SecretScrubber, fn: (b: Browser) => Promise<T>): Promise<T> => {
    const onBlocked = (url: string) => {
      try {
        opts.emit(scrubber.scrub({ type: "blocked_request", jobId, url }));
      } catch {
        return;
      }
    };
    const browser = await opts.openBrowser({ onBlocked, scrubber });
    try {
      return await fn(browser);
    } finally {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([browser.close().catch(() => undefined), new Promise((r) => (timer = setTimeout(r, CLOSE_TIMEOUT_MS)))]);
      clearTimeout(timer);
    }
  };
  const failure = (scrubber: SecretScrubber, err: unknown) => scrubber.scrub(err instanceof Error ? err.message : String(err));
  const noUsage = (model: string) => ({ model, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 });
  const recordFailure = (jobId: string, kind: "role_session" | "replay", error: string) => {
    try {
      opts.emit({ type: "job_started", jobId, kind });
      opts.emit({ type: "job_finished", jobId, usage: noUsage(opts.agentModelId), stoppedBy: "error", error });
    } catch {
      return;
    }
  };

  for (const persona of opts.project.personas) {
    if (budget.exceeded) break;
    const jobId = `role:${persona.id}`;
    const scrubber = scrubberFor();
    const { result, usage } = await withBrowser(jobId, scrubber, (b) =>
      runRoleSession({
        model: opts.agentModel, modelId: opts.agentModelId, persona, project: opts.project,
        browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: opts.maxSteps, emit: opts.emit,
        newFindingId: () => `f${++findingNo}`,
      }),
    ).catch((err): { result: RoleResult; usage: ReturnType<typeof noUsage> } => {
      const error = failure(scrubber, err);
      recordFailure(jobId, "role_session", error);
      return {
        result: { persona: persona.id, goals: opts.project.goals.map((g) => ({ goal: g.id, status: "not_attempted", note: "" })), findings: [], stoppedBy: "error", error },
        usage: noUsage(opts.agentModelId),
      };
    });
    summary.roles.push(result);
    summary.jobs.push({ jobId, ...usage });
  }

  for (const role of summary.roles) {
    const accountRef = opts.project.personas.find((p) => p.id === role.persona)?.accountRef;
    for (const finding of role.findings.filter((f) => f.kind === "defect")) {
      if (budget.exceeded) break;
      const scrubber = scrubberFor();
      const replayed = await withBrowser(`replay:${finding.id}`, scrubber, (b) =>
        runReplay({
          model: opts.agentModel, modelId: opts.agentModelId, finding, project: opts.project, accountRef,
          browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: opts.replaySteps, emit: opts.emit,
        }),
      ).catch((err) => {
        const error = failure(scrubber, err);
        recordFailure(`replay:${finding.id}`, "replay", error);
        summary.replayErrors[finding.id] = error;
        summary.jobs.push({ jobId: `replay:${finding.id}`, ...noUsage(opts.agentModelId) });
        return null;
      });
      if (!replayed) continue;
      const { observation, usage } = replayed;
      summary.jobs.push({ jobId: `replay:${finding.id}`, ...usage });
      summary.replays[finding.id] = observation;
      const wroteNoReport = !observation.completed && observation.blockedAt === null;
      if (wroteNoReport || budget.exceeded) continue;
      const judged = await judge({ model: opts.judgeModel, modelId: opts.judgeModelId, finding, observation, scrubber, budget, emit: opts.emit });
      summary.jobs.push({ jobId: `judge:${finding.id}`, ...judged.usage });
      summary.verdicts[finding.id] = judged.verdict;
    }
  }

  summary.totalCostUsd = budget.spent;
  summary.finishedAt = new Date().toISOString();
  return summary;
}
