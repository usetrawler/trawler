import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { railway, target, type Railway, type Target } from "./railway.ts";

export interface Images {
  migrate: string;
  controlPlane: string;
  runner: string;
}

export interface DeployOptions {
  core: Railway;
  workers: Railway;
  environment: string;
  commit: string;
  images: Images;
  deployed: () => Promise<string | null>;
  isAncestor: (older: string, newer: string) => boolean | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  pollMs?: number;
  timeoutMs?: number;
}

export class DeployFailed extends Error {}

interface Deployment {
  status: string;
  deploymentStopped: boolean;
  meta: { image?: string; commitHash?: string | null } | null;
  instances: Array<{ status: string }>;
}

const ENDED = new Set(["CRASHED", "FAILED", "REMOVED", "REMOVING", "SKIPPED", "NEEDS_APPROVAL"]);

function clock(o: DeployOptions) {
  return {
    sleep: o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: o.now ?? Date.now,
    log: o.log ?? console.log,
    pollMs: o.pollMs ?? 5_000,
    timeoutMs: o.timeoutMs ?? 10 * 60_000,
  };
}

async function poll<T>(o: DeployOptions, what: string, read: () => Promise<T>, done: (value: T) => boolean, stuck: (value: T | undefined) => string): Promise<T> {
  const { sleep, now, log, pollMs, timeoutMs } = clock(o);
  const deadline = now() + timeoutMs;
  let last: T | undefined;
  while (true) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch (err) {
      if (err instanceof DeployFailed) throw err;
      log(`${what}: Railway did not answer (${err instanceof Error ? err.message : String(err)}), asking again`);
    }
    if (now() >= deadline) throw new DeployFailed(stuck(last));
    await sleep(pollMs);
  }
}

type Source = { image: string | null; repo: string | null } | null;

async function switchSource(o: DeployOptions, api: Railway, at: Target, service: string, serviceId: string, image: string): Promise<void> {
  await api.query("mutation($env: String!, $patch: EnvironmentConfig!) { environmentPatchCommit(environmentId: $env, patch: $patch, commitMessage: \"release\", skipDeploys: true) }", {
    env: at.environmentId, patch: { services: { [serviceId]: { source: { image, repo: null, branch: null } } } },
  });
  await poll<Source>(
    o,
    service,
    async () => {
      const { serviceInstance } = await api.query<{ serviceInstance: { source: Source } }>(
        "query($env: String!, $svc: String!) { serviceInstance(environmentId: $env, serviceId: $svc) { source { image repo } } }",
        { env: at.environmentId, svc: serviceId },
      );
      return serviceInstance.source;
    },
    (source) => source?.image === image && !source.repo,
    (source) =>
      source === undefined
        ? `Railway did not answer while ${service} was switched to ${image}`
        : `Railway did not switch ${service} to ${image}; ${source?.repo ? `it still builds from ${source.repo}` : `its image is ${source?.image ?? "not set"}`}`,
  );
}

async function release(o: DeployOptions, api: Railway, at: Target, service: string, serviceId: string, image: string, until: "running" | "exited"): Promise<string> {
  const { log } = clock(o);
  await switchSource(o, api, at, service, serviceId, image);
  const { serviceInstanceDeployV2: id } = await api.query<{ serviceInstanceDeployV2: string }>(
    "mutation($env: String!, $svc: String!) { serviceInstanceDeployV2(environmentId: $env, serviceId: $svc) }",
    { env: at.environmentId, svc: serviceId },
  );
  log(`${service}: deploying ${image} as ${id}`);
  const expected = until === "exited" ? { stopped: true, instance: "EXITED" } : { stopped: false, instance: "RUNNING" };
  const read = async () => {
    const { deployment } = await api.query<{ deployment: Deployment }>("query($id: String!) { deployment(id: $id) { status deploymentStopped meta instances { status } } }", { id });
    const wrong = deployment.meta?.commitHash ? `a build of ${deployment.meta.commitHash}` : deployment.meta?.image !== undefined && deployment.meta.image !== image ? deployment.meta.image : undefined;
    if (wrong) {
      await api.query("mutation($id: String!) { deploymentCancel(id: $id) }", { id }).catch(() => undefined);
      throw new DeployFailed(`${service} deployment ${id} runs ${wrong}, not ${image}`);
    }
    const instances = deployment.instances.map((i) => i.status);
    if (ENDED.has(deployment.status)) throw new DeployFailed(`${service} deployment ${id} ended ${deployment.status}`);
    if (instances.includes("CRASHED")) throw new DeployFailed(`${service} deployment ${id} crashed`);
    if (until === "running" && deployment.status === "SUCCESS" && deployment.deploymentStopped && instances.length > 0 && instances.every((s) => s === "EXITED")) {
      throw new DeployFailed(`${service} deployment ${id} exited instead of running`);
    }
    return { ...deployment, states: instances };
  };
  const deployment = await poll(
    o,
    service,
    read,
    (d) => d.status === "SUCCESS" && d.deploymentStopped === expected.stopped && d.states.length > 0 && d.states.every((s) => s === expected.instance),
    (d) => `${service} deployment ${id} is still ${d?.status ?? "unknown"}${d?.states.length ? ` (${d.states.join(", ")})` : ""}`,
  );
  if (deployment.meta?.image !== image) throw new DeployFailed(`${service} deployment ${id} runs ${deployment.meta?.image ?? "an unknown image"}, not ${image}`);
  log(`${service}: ${until === "exited" ? "finished" : "running"}`);
  return id;
}

async function soleDeployment(o: DeployOptions, api: Railway, at: Target, service: string, serviceId: string, id: string): Promise<void> {
  const { log } = clock(o);
  await poll(
    o,
    service,
    async () => {
      const { serviceInstance } = await api.query<{ serviceInstance: { activeDeployments: Array<{ id: string }> } }>(
        "query($env: String!, $svc: String!) { serviceInstance(environmentId: $env, serviceId: $svc) { activeDeployments { id } } }",
        { env: at.environmentId, svc: serviceId },
      );
      const ids = serviceInstance.activeDeployments.map((d) => d.id);
      if (!ids.includes(id)) throw new DeployFailed(`${service} deployment ${id} is no longer active`);
      return ids;
    },
    (ids) => ids.length === 1,
    () => `${service} still has an older deployment running next to ${id}`,
  );
  log(`${service}: the previous deployment is gone`);
}

export function gitAncestry(status: number | null): boolean | undefined {
  return status === 0 ? true : status === 1 ? false : undefined;
}

export async function deployedCommit(base: string, call: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await call(`${base}/healthz`, { headers: { "cache-control": "no-store" } });
    return ((await res.json()) as { commit?: string | null }).commit ?? null;
  } catch {
    return null;
  }
}

export async function deploy(o: DeployOptions): Promise<void> {
  const [core, workers] = await Promise.all([target(o.core), target(o.workers)]);
  for (const [token, at] of [["RAILWAY_CORE_TOKEN", core], ["RAILWAY_WORKERS_TOKEN", workers]] as const) {
    if (at.environmentName !== o.environment) throw new DeployFailed(`${token} belongs to the Railway environment ${at.environmentName}, not ${o.environment}`);
  }
  const running = await o.deployed();
  if (running && running !== o.commit) {
    const older = o.isAncestor(o.commit, running);
    if (older) throw new DeployFailed(`${o.environment} already runs ${running}, which is newer than ${o.commit}`);
    if (older === undefined) clock(o).log(`${o.environment} runs ${running}, which git does not know; deploying ${o.commit} anyway`);
  }
  const migrate = core.service("migrate");
  const controlPlane = core.service("control-plane");
  const runner = workers.service("runner");
  await release(o, o.core, core, "migrate", migrate, o.images.migrate, "exited");
  const [, runnerDeployment] = await Promise.all([
    release(o, o.core, core, "control-plane", controlPlane, o.images.controlPlane, "running"),
    release(o, o.workers, workers, "runner", runner, o.images.runner, "running"),
  ]);
  await soleDeployment(o, o.workers, workers, "runner", runner, runnerDeployment);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const missing = ["RELEASE_ENVIRONMENT", "RELEASE_URL", "RELEASE_COMMIT", "RAILWAY_CORE_TOKEN", "RAILWAY_WORKERS_TOKEN", "IMAGE_MIGRATE", "IMAGE_CONTROL_PLANE", "IMAGE_RUNNER"].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`missing environment variables: ${missing.join(", ")}`);
    process.exit(2);
  }
  deploy({
    core: railway(env.RAILWAY_CORE_TOKEN!),
    workers: railway(env.RAILWAY_WORKERS_TOKEN!),
    environment: env.RELEASE_ENVIRONMENT!,
    commit: env.RELEASE_COMMIT!,
    images: { migrate: env.IMAGE_MIGRATE!, controlPlane: env.IMAGE_CONTROL_PLANE!, runner: env.IMAGE_RUNNER! },
    deployed: () => deployedCommit(env.RELEASE_URL!),
    isAncestor: (older, newer) => gitAncestry(spawnSync("git", ["merge-base", "--is-ancestor", older, newer]).status),
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
