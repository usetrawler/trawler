import type { LanguageModel } from "ai";
import { z } from "zod";
import { Budget, judge, MIN_SECRET_LENGTH, runReplay, runRoleSession, SecretScrubber, type Browser } from "@usetrawler/core";
import {
  JobAssignmentSchema, MAX_EVENTS_PER_BATCH, MAX_URL, PROTOCOL_HEADER, PROTOCOL_VERSION,
  type JobAssignment, type JobCompletion, type JobStopReason, type JobUsage, type ProjectConfig, type RunEvent, type RunEventInput,
} from "@usetrawler/protocol";

export interface WorkerDeps {
  controlPlane: string;
  runnerToken: string;
  model: (modelId: string, jobToken: string) => LanguageModel;
  openBrowser: (config: ProjectConfig, opts: { onBlocked: (url: string) => void; scrubber: SecretScrubber }) => Promise<Browser>;
  log: (line: string) => void;
  fetch?: typeof fetch;
  flushMs?: number;
  heartbeatMs?: number;
  retryBaseMs?: number;
  attempts?: number;
  secrets?: string[];
}

const CLOSE_TIMEOUT_MS = 10_000;
const MAX_ERROR = 2000;
const MAX_BATCH_BYTES = 1_500_000;

const clip = (s: string) => Array.from(s).slice(0, MAX_ERROR).join("");

class Unauthorized extends Error {}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function call(deps: WorkerDeps, path: string, bearer: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const attempts = deps.attempts ?? 6;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await (deps.fetch ?? fetch)(new URL(path, deps.controlPlane), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
        body: JSON.stringify(body),
        signal,
      });
      if (res.status === 401) throw new Unauthorized(`the control plane refused ${path}`);
      if (res.status === 426) throw new Error(await res.text());
      if (res.status < 500 && res.status !== 429) return res;
      last = new Error(`HTTP ${res.status} from ${path}`);
    } catch (err) {
      if (err instanceof Unauthorized || signal?.aborted) throw err;
      last = err;
    }
    if (i < attempts - 1) await pause((deps.retryBaseMs ?? 500) * 2 ** i * (0.5 + Math.random()), signal);
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
  failure?: Error;

  #heartbeat: NodeJS.Timeout;

  constructor(private deps: WorkerDeps, private job: JobAssignment, private onCancel: () => void) {
    this.#heartbeat = setInterval(() => void this.flush(true), deps.heartbeatMs ?? 120_000);
  }

  stop() {
    clearInterval(this.#heartbeat);
  }

  emit = (e: RunEventInput) => {
    if (this.failure) return;
    const event = { ...e, jobId: this.job.jobId, seq: ++this.#seq, at: new Date().toISOString() } as RunEvent;
    if (event.type === "job_finished") {
      if (event.error) event.error = clip(event.error);
      this.finished = event;
    }
    this.#queue.push(event);
    this.#timer ??= setTimeout(() => void this.flush(), this.deps.flushMs ?? 1000);
  };

  flush(beat = false): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#flushing = this.#flushing.then(async () => {
      if (this.failure) return;
      let sendEmpty = beat && this.#queue.length === 0;
      while (this.#queue.length > 0 || sendEmpty) {
        sendEmpty = false;
        const batch = this.#nextBatch();
        const res = await call(this.deps, `/api/jobs/${this.job.jobId}/events`, this.job.token, { events: batch });
        if (!res.ok) throw new Error(`the control plane rejected events: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
        this.#queue.splice(0, batch.length);
        const { cancel } = (await res.json()) as { cancel: boolean };
        if (cancel && !this.cancelled) {
          this.cancelled = true;
          this.onCancel();
        }
      }
    }).catch((err: unknown) => {
      this.failure = err instanceof Error ? err : new Error(String(err));
      this.#queue = [];
      this.onCancel();
    });
    return this.#flushing;
  }

  #nextBatch(): RunEvent[] {
    let bytes = 0;
    let n = 0;
    while (n < this.#queue.length && n < MAX_EVENTS_PER_BATCH) {
      bytes += Buffer.byteLength(JSON.stringify(this.#queue[n]));
      if (n > 0 && bytes > MAX_BATCH_BYTES) break;
      n++;
    }
    return this.#queue.slice(0, n);
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
        model: deps.model(job.agentModel, job.token), modelId: job.agentModel, persona, project: config, browserTools: b.tools, fillField: b.fillField,
        scrubber, budget, maxSteps: job.maxSteps, emit: events.emit, newFindingId: () => `f${++n}`,
      }),
    );
    return { usage, stoppedBy: result.stoppedBy, ...(result.error ? { error: clip(result.error) } : {}) };
  }
  if (!job.finding) throw new Error("the job has no finding");
  const finding = job.finding;
  if (job.kind === "replay") {
    const { observation, usage } = await withBrowser(deps, config, scrubber, events, job.jobId, (b) =>
      runReplay({
        model: deps.model(job.agentModel, job.token), modelId: job.agentModel, finding, project: config, accountRef: job.accountRef,
        browserTools: b.tools, fillField: b.fillField, scrubber, budget, maxSteps: job.maxSteps, emit: events.emit,
      }),
    );
    return { usage, stoppedBy: events.finished?.stoppedBy ?? "error", observation, ...(events.finished?.error ? { error: clip(events.finished.error) } : {}) };
  }
  if (!job.observation) throw new Error("the judge job has no observation");
  const { usage } = await judge({ model: deps.model(job.judgeModel, job.token), modelId: job.judgeModel, finding, observation: job.observation, scrubber, budget, emit: events.emit });
  return { usage, stoppedBy: events.finished?.stoppedBy ?? "done", ...(events.finished?.error ? { error: clip(events.finished.error) } : {}) };
}

function runnerScrubber(deps: WorkerDeps, config: ProjectConfig): SecretScrubber {
  const scrubber = SecretScrubber.forProject(config);
  for (const secret of deps.secrets ?? []) {
    if (secret.length >= MIN_SECRET_LENGTH) scrubber.add(secret);
  }
  return scrubber;
}

async function complete(deps: WorkerDeps, job: { jobId: string; token: string }, completion: JobCompletion): Promise<void> {
  const res = await call(deps, `/api/jobs/${job.jobId}/complete`, job.token, completion);
  if (!res.ok) throw new Error(`the control plane rejected the completion: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
}

async function assignment(deps: WorkerDeps, res: Response): Promise<JobAssignment | null> {
  const body: unknown = await res.json();
  const parsed = JobAssignmentSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const ids = z.object({ jobId: z.string().uuid(), token: z.string().min(16) }).safeParse(body);
  const reason = `this runner cannot read the job: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  deps.log(reason);
  if (ids.success) await complete(deps, ids.data, { usage: zeroUsage(""), stoppedBy: "error", error: clip(reason) }).catch(() => undefined);
  return null;
}

export async function workOnce(deps: WorkerDeps, signal?: AbortSignal): Promise<"idle" | "done"> {
  let res: Response;
  try {
    res = await call(deps, "/api/runner/claim", deps.runnerToken, {}, signal);
  } catch (err) {
    if (signal?.aborted) return "idle";
    throw err;
  }
  if (res.status === 204) return "idle";
  if (!res.ok) throw new Error(`claim failed: HTTP ${res.status}`);
  let job: JobAssignment | null;
  try {
    job = await assignment(deps, res);
  } catch (err) {
    if (signal?.aborted) return "idle";
    throw err;
  }
  if (!job) return "done";
  deps.log(`${job.kind} ${job.jobId} started`);
  const scrubber = runnerScrubber({ ...deps, secrets: [...(deps.secrets ?? []), job.token] }, job.config);
  const budget = new Budget(Math.max(job.budgetUsd, 1e-6));
  if (job.budgetUsd <= 0) budget.add(1e-6);
  const events = new JobEvents(deps, job, () => budget.add(budget.limitUsd));
  let released: Promise<boolean> | undefined;
  const handOver = () => {
    released ??= call(deps, `/api/jobs/${job.jobId}/release`, job.token, {})
      .then((r) => r.ok)
      .catch(() => false);
    budget.add(budget.limitUsd);
  };
  signal?.addEventListener("abort", handOver, { once: true });
  let completion: JobCompletion;
  try {
    completion = await run(deps, job, events, budget, scrubber);
    if (events.cancelled && completion.stoppedBy !== "error") completion = { ...completion, stoppedBy: "budget" };
  } catch (err) {
    completion = { usage: zeroUsage(job.agentModel), stoppedBy: "error", error: clip(scrubber.scrub(err instanceof Error ? err.message : String(err))) };
  }
  signal?.removeEventListener("abort", handOver);
  if (released) {
    events.stop();
    const handedOver = await released;
    deps.log(`${job.kind} ${job.jobId} ${handedOver ? "handed back to the queue because the runner is stopping" : "could not be handed back; it will be retried when its lease expires"}`);
    return "done";
  }
  events.stop();
  await events.flush();
  if (events.failure) {
    deps.log(`${job.kind} ${job.jobId} could not report events: ${events.failure.message}`);
    const reported = `the runner could not report events: ${scrubber.scrub(events.failure.message)}`;
    completion = { ...completion, stoppedBy: "error", error: clip(completion.error ? `${reported}; ${completion.error}` : reported) };
  }
  try {
    await complete(deps, job, completion);
    deps.log(`${job.kind} ${job.jobId} finished (${completion.stoppedBy})${completion.error ? `: ${completion.error}` : ""}`);
  } catch (err) {
    deps.log(`${job.kind} ${job.jobId} could not report back: ${err instanceof Error ? err.message : String(err)}`);
  }
  return "done";
}

export async function workLoop(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await workOnce(deps, signal);
    } catch (err) {
      deps.log(`claim failed: ${err instanceof Error ? err.message : String(err)}`);
      await pause(5000, signal);
    }
  }
}
