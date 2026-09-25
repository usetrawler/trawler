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
  images: Images;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  pollMs?: number;
  timeoutMs?: number;
}

export class DeployFailed extends Error {}

const ENDED = new Set(["CRASHED", "FAILED", "REMOVED", "REMOVING", "SKIPPED", "NEEDS_APPROVAL"]);

function clock(o: DeployOptions) {
  return {
    sleep: o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: o.now ?? Date.now,
    log: o.log ?? console.log,
    pollMs: o.pollMs ?? 5_000,
    timeoutMs: o.timeoutMs ?? 20 * 60_000,
  };
}

async function release(o: DeployOptions, api: Railway, at: Target, service: string, serviceId: string, image: string, until: "running" | "exited"): Promise<string> {
  const { sleep, now, log, pollMs, timeoutMs } = clock(o);
  await api.query("mutation($env: String!, $svc: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId: $env, serviceId: $svc, input: $input) }", {
    env: at.environmentId, svc: serviceId, input: { source: { image } },
  });
  const { serviceInstanceDeployV2: id } = await api.query<{ serviceInstanceDeployV2: string }>(
    "mutation($env: String!, $svc: String!) { serviceInstanceDeployV2(environmentId: $env, serviceId: $svc) }",
    { env: at.environmentId, svc: serviceId },
  );
  log(`${service}: deploying ${image} as ${id}`);
  const deadline = now() + timeoutMs;
  while (true) {
    const { deployment } = await api.query<{ deployment: { status: string; deploymentStopped: boolean; meta: { image?: string } | null } }>(
      "query($id: String!) { deployment(id: $id) { status deploymentStopped meta } }",
      { id },
    );
    if (ENDED.has(deployment.status)) throw new DeployFailed(`${service} deployment ${id} ended ${deployment.status}`);
    if (deployment.status === "SUCCESS" && (until === "running" || deployment.deploymentStopped)) {
      const running = deployment.meta?.image;
      if (running !== image) throw new DeployFailed(`${service} deployment ${id} runs ${running ?? "an unknown image"}, not ${image}`);
      log(`${service}: ${until === "exited" ? "finished" : "running"}`);
      return id;
    }
    if (now() >= deadline) throw new DeployFailed(`${service} deployment ${id} is still ${deployment.status}`);
    await sleep(pollMs);
  }
}

async function soleDeployment(o: DeployOptions, api: Railway, at: Target, service: string, serviceId: string, id: string): Promise<void> {
  const { sleep, now, log, pollMs, timeoutMs } = clock(o);
  const deadline = now() + timeoutMs;
  while (true) {
    const { serviceInstance } = await api.query<{ serviceInstance: { activeDeployments: Array<{ id: string }> } }>(
      "query($env: String!, $svc: String!) { serviceInstance(environmentId: $env, serviceId: $svc) { activeDeployments { id } } }",
      { env: at.environmentId, svc: serviceId },
    );
    const ids = serviceInstance.activeDeployments.map((d) => d.id);
    if (ids.length === 1 && ids[0] === id) {
      log(`${service}: the previous deployment is gone`);
      return;
    }
    if (now() >= deadline) throw new DeployFailed(`${service} still has an older deployment running next to ${id}`);
    await sleep(pollMs);
  }
}

export async function deploy(o: DeployOptions): Promise<void> {
  const [core, workers] = await Promise.all([target(o.core), target(o.workers)]);
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
  const missing = ["RAILWAY_CORE_TOKEN", "RAILWAY_WORKERS_TOKEN", "IMAGE_MIGRATE", "IMAGE_CONTROL_PLANE", "IMAGE_RUNNER"].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`missing environment variables: ${missing.join(", ")}`);
    process.exit(2);
  }
  deploy({
    core: railway(env.RAILWAY_CORE_TOKEN!),
    workers: railway(env.RAILWAY_WORKERS_TOKEN!),
    images: { migrate: env.IMAGE_MIGRATE!, controlPlane: env.IMAGE_CONTROL_PLANE!, runner: env.IMAGE_RUNNER! },
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
