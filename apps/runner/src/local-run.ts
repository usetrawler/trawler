import type { LanguageModel } from "ai";
import { Budget, judge, runReplay, runRoleSession, SecretScrubber, type Browser } from "@usetrawler/core";
import type { ProjectConfig, RunEventInput } from "@usetrawler/protocol";
import type { RunSummary } from "./run-dir.ts";

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
    startedAt, finishedAt: startedAt, budgetUsd: opts.budgetUsd, totalCostUsd: 0, jobs: [], roles: [], replays: {}, verdicts: {},
  };
  const scrubberFor = () => SecretScrubber.forProject(opts.project);
  let findingNo = 0;

  const withBrowser = async <T>(jobId: string, scrubber: SecretScrubber, fn: (b: Browser) => Promise<T>): Promise<T> => {
    const browser = await opts.openBrowser({ onBlocked: (url) => opts.emit(scrubber.scrub({ type: "blocked_request", jobId, url })), scrubber });
    try {
      return await fn(browser);
    } finally {
      await browser.close().catch(() => undefined);
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
    );
    summary.roles.push(result);
    summary.jobs.push({ jobId, ...usage });
  }

  for (const role of summary.roles) {
    const accountRef = opts.project.personas.find((p) => p.id === role.persona)?.accountRef;
    for (const finding of role.findings.filter((f) => f.kind === "defect")) {
      if (budget.exceeded) break;
      const scrubber = scrubberFor();
      const { observation, usage } = await withBrowser(`replay:${finding.id}`, scrubber, (b) =>
        runReplay({
          model: opts.agentModel, modelId: opts.agentModelId, finding, project: opts.project, accountRef,
          browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: opts.replaySteps, emit: opts.emit,
        }),
      );
      summary.jobs.push({ jobId: `replay:${finding.id}`, ...usage });
      summary.replays[finding.id] = observation;
      const judged = await judge({ model: opts.judgeModel, modelId: opts.judgeModelId, finding, observation, scrubber, budget, emit: opts.emit });
      summary.jobs.push({ jobId: `judge:${finding.id}`, ...judged.usage });
      summary.verdicts[finding.id] = judged.verdict;
    }
  }

  summary.totalCostUsd = budget.spent;
  summary.finishedAt = new Date().toISOString();
  return summary;
}
