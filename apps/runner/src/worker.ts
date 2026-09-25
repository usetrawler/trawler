import type { LanguageModel } from "ai";
import { Budget, judge, runReplay, runRoleSession, SecretScrubber, type Browser } from "@usetrawler/core";
import {
  JobAssignmentSchema, MAX_EVENTS_PER_BATCH, MAX_URL, PROTOCOL_HEADER, PROTOCOL_VERSION,
  type JobAssignment, type JobCompletion, type JobStopReason, type JobUsage, type ProjectConfig, type RunEvent, type RunEventInput,
} from "@usetrawler/protocol";

export interface WorkerDeps {
  controlPlane: string;
  runnerToken: string;
  model: (modelId: string) => LanguageModel;
  openBrowser: (config: ProjectConfig, opts: { onBlocked: (url: string) => void; scrubber: SecretScrubber }) => Promise<Browser>;
  log: (line: string) => void;
  fetch?: typeof fetch;
  flushMs?: number;
  heartbeatMs?: number;
  retryBaseMs?: number;
  attempts?: number;
}

const CLOSE_TIMEOUT_MS = 10_000;

class Unauthorized extends Error {}

async function call(deps: WorkerDeps, path: string, bearer: string, body: unknown): Promise<Response> {
  const attempts = deps.attempts ?? 6;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await (deps.fetch ?? fetch)(new URL(path, deps.controlPlane), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
        body: JSON.stringify(body),
      });
      if (res.status === 401) throw new Unauthorized(`the control plane refused ${path}`);
      if (res.status === 426) throw new Error(await res.text());
      if (res.status < 500 && res.status !== 429) return res;
      last = new Error(`HTTP ${res.status} from ${path}`);
    } catch (err) {
      if (err instanceof Unauthorized) throw err;
      last = err;
    }
    await new Promise((r) => setTimeout(r, (deps.retryBaseMs ?? 500) * 2 ** i));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

class JobEvents {
  #seq = 0;
  #queue: RunEvent[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> = Promise.resolve();
  finished?: Extract<RunEvent, { type: "job_finished" }>;
  cancelled = false;

  #heartbeat: NodeJS.Timeout;

  constructor(private deps: WorkerDeps, private job: JobAssignment, private onCancel: () => void) {
    this.#heartbeat = setInterval(() => void this.flush(true).catch(() => undefined), deps.heartbeatMs ?? 120_000);
  }

  stop() {
    clearInterval(this.#heartbeat);
  }

  emit = (e: RunEventInput) => {
    const event = { ...e, jobId: this.job.jobId, seq: ++this.#seq, at: new Date().toISOString() } as RunEvent;
    if (event.type === "job_finished") this.finished = event;
    this.#queue.push(event);
    this.#timer ??= setTimeout(() => void this.flush(), this.deps.flushMs ?? 1000);
  };

  flush(beat = false): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#flushing = this.#flushing.then(async () => {
      let sendEmpty = beat && this.#queue.length === 0;
      while (this.#queue.length > 0 || sendEmpty) {
        sendEmpty = false;
        const batch = this.#queue.slice(0, MAX_EVENTS_PER_BATCH);
        const res = await call(this.deps, `/api/jobs/${this.job.jobId}/events`, this.job.token, { events: batch });
        if (!res.ok) throw new Error(`the control plane rejected events: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
        this.#queue.splice(0, batch.length);
        const { cancel } = (await res.json()) as { cancel: boolean };
        if (cancel && !this.cancelled) {
          this.cancelled = true;
          this.onCancel();
        }
      }
    });
    return this.#flushing;
  }
}

const zeroUsage = (model: string): JobUsage => ({ model, inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 });

async function withBrowser<T>(deps: WorkerDeps, config: ProjectConfig, scrubber: SecretScrubber, events: JobEvents, jobId: string, fn: (b: Browser) => Promise<T>): Promise<T> {
  const browser = await deps.openBrowser(config, { scrubber, onBlocked: (url) => events.emit(scrubber.scrub({ type: "blocked_request", jobId, url: url.slice(0, MAX_URL) })) });
  try {
    return await fn(browser);
  } finally {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([browser.close().catch(() => undefined), new Promise((r) => (timer = setTimeout(r, CLOSE_TIMEOUT_MS)))]);
    clearTimeout(timer);
  }
}

async function run(deps: WorkerDeps, job: JobAssignment, events: JobEvents, budget: Budget, scrubber: SecretScrubber): Promise<JobCompletion> {
  const { config } = job;
  if (job.kind === "role_session") {
    const persona = config.personas.find((p) => p.id === job.personaKey);
    if (!persona) throw new Error(`persona ${job.personaKey} is not in the project`);
    let n = 0;
    const { result, usage } = await withBrowser(deps, config, scrubber, events, job.jobId, (b) =>
      runRoleSession({
        model: deps.model(job.agentModel), modelId: job.agentModel, persona, project: config, browserTools: b.tools, fillField: b.fillField,
        scrubber, budget, maxSteps: job.maxSteps, emit: events.emit, newFindingId: () => `f${++n}`,
      }),
    );
    return { usage, stoppedBy: result.stoppedBy, ...(result.error ? { error: result.error } : {}) };
  }
  if (!job.finding) throw new Error("the job has no finding");
  const finding = job.finding;
  if (job.kind === "replay") {
    const { observation, usage } = await withBrowser(deps, config, scrubber, events, job.jobId, (b) =>
      runReplay({
        model: deps.model(job.agentModel), modelId: job.agentModel, finding, project: config, accountRef: job.accountRef,
        browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: job.maxSteps, emit: events.emit,
      }),
    );
    return { usage, stoppedBy: events.finished?.stoppedBy ?? "error", observation, ...(events.finished?.error ? { error: events.finished.error } : {}) };
  }
  if (!job.observation) throw new Error("the judge job has no observation");
  const { usage } = await judge({ model: deps.model(job.judgeModel), modelId: job.judgeModel, finding, observation: job.observation, scrubber, budget, emit: events.emit });
  return { usage, stoppedBy: events.finished?.stoppedBy ?? "done", ...(events.finished?.error ? { error: events.finished.error } : {}) };
}

export async function workOnce(deps: WorkerDeps): Promise<"idle" | "done"> {
  const res = await call(deps, "/api/runner/claim", deps.runnerToken, {});
  if (res.status === 204) return "idle";
  if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`);
  const job = JobAssignmentSchema.parse(await res.json());
  deps.log(`${job.kind} ${job.jobId} started`);
  const scrubber = SecretScrubber.forProject(job.config);
  const budget = new Budget(Math.max(job.budgetUsd, 1e-6));
  if (job.budgetUsd <= 0) budget.add(1e-6);
  const events = new JobEvents(deps, job, () => budget.add(budget.limitUsd));
  let completion: JobCompletion;
  try {
    completion = await run(deps, job, events, budget, scrubber);
    if (events.cancelled && completion.stoppedBy !== "error") completion = { ...completion, stoppedBy: "budget" };
  } catch (err) {
    completion = { usage: zeroUsage(job.agentModel), stoppedBy: "error", error: scrubber.scrub(err instanceof Error ? err.message : String(err)).slice(0, 2000) };
  }
  try {
    events.stop();
    await events.flush();
    await call(deps, `/api/jobs/${job.jobId}/complete`, job.token, completion);
    deps.log(`${job.kind} ${job.jobId} finished (${completion.stoppedBy})`);
  } catch (err) {
    deps.log(`${job.kind} ${job.jobId} could not report back: ${err instanceof Error ? err.message : String(err)}`);
  }
  return "done";
}

export async function workLoop(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await workOnce(deps);
    } catch (err) {
      deps.log(`claim failed: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
