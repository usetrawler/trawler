import { expect, test } from "vitest";
import { deploy, deployedCommit, type DeployOptions } from "./deploy.ts";
import { railway } from "./railway.ts";

type Deployment = { status: string; deploymentStopped: boolean; image?: string; instances?: string[] };
type Source = { image: string | null; repo: string | null };

interface FakeProject {
  project: string;
  environment: string;
  environmentName?: string;
  services: Record<string, string>;
  deployments: Record<string, Deployment[]>;
  active?: string[][];
  keepsRepo?: boolean;
  lagReads?: number;
  buildsRepo?: boolean;
  noImageMeta?: boolean;
  failPolls?: number;
}

function fakeRailway(opts: FakeProject) {
  const calls: Array<{ op: string; variables: Record<string, unknown>; token: string | null }> = [];
  const source = new Map<string, Source>(Object.values(opts.services).map((id) => [id, { image: null, repo: "usetrawler/trawler" }]));
  const deployedFrom = new Map<string, Source>();
  const nameOf = (id: unknown) => Object.entries(opts.services).find(([, sid]) => sid === id)![0];
  const pending = new Map<string, Source>();
  let active = opts.active ?? [];
  let failPolls = opts.failPolls ?? 0;
  let lagReads = opts.lagReads ?? 0;
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /\{\s*(\w+)/.exec(query)![1]!;
    calls.push({ op, variables, token: new Headers(init?.headers).get("project-access-token") });
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (op === "projectToken") return reply({ projectToken: { projectId: opts.project, environmentId: opts.environment, environment: { name: opts.environmentName ?? "staging" } } });
    if (op === "project") return reply({ project: { services: { edges: Object.entries(opts.services).map(([name, id]) => ({ node: { id, name } })) } } });
    if (op === "environmentPatchCommit") {
      for (const [id, config] of Object.entries((variables.patch as { services: Record<string, { source: Source }> }).services)) {
        const previous = source.get(id)!;
        pending.set(id, { image: config.source.image, repo: opts.keepsRepo ? previous.repo : config.source.repo });
      }
      return reply({ environmentPatchCommit: "patch" });
    }
    if (op === "serviceInstanceDeployV2") {
      deployedFrom.set(`dep-${nameOf(variables.svc)}`, { ...source.get(String(variables.svc))! });
      return reply({ serviceInstanceDeployV2: `dep-${nameOf(variables.svc)}` });
    }
    if (op === "deploymentCancel") return reply({ deploymentCancel: true });
    if (op === "deployment") {
      if (failPolls > 0) {
        failPolls--;
        return new Response("upstream error", { status: 502 });
      }
      const from = deployedFrom.get(String(variables.id))!;
      const queue = opts.deployments[String(variables.id).slice("dep-".length)]!;
      const { image, instances, ...deployment } = (queue.length > 1 ? queue.shift() : queue[0])!;
      const meta = from.repo || opts.buildsRepo ? { commitHash: "0ld" } : opts.noImageMeta ? {} : { image: image ?? from.image };
      const settled = deployment.status === "SUCCESS" ? [deployment.deploymentStopped ? "EXITED" : "RUNNING"] : [];
      return reply({ deployment: { ...deployment, meta, instances: (instances ?? settled).map((status) => ({ status })) } });
    }
    if (query.includes("activeDeployments")) {
      const ids = active.length > 1 ? active.shift()! : active[0] ?? [];
      return reply({ serviceInstance: { activeDeployments: ids.map((id) => ({ id })) } });
    }
    const id = String(variables.svc);
    if (pending.has(id) && lagReads-- <= 0) {
      source.set(id, pending.get(id)!);
      pending.delete(id);
    }
    return reply({ serviceInstance: { source: source.get(id) } });
  }) as typeof globalThis.fetch;
  return { calls, fetch: fakeFetch, source };
}

const images = { migrate: "ghcr.io/x/migrate@sha256:1", controlPlane: "ghcr.io/x/control-plane@sha256:2", runner: "ghcr.io/x/runner@sha256:3" };
const up = { status: "SUCCESS", deploymentStopped: false };
const exited = { status: "SUCCESS", deploymentStopped: true };
const coreServices = { migrate: "s-migrate", "control-plane": "s-cp", Postgres: "s-pg" };

function options(core: ReturnType<typeof fakeRailway>, workers: ReturnType<typeof fakeRailway>, over: Partial<DeployOptions> = {}): DeployOptions {
  let clock = 0;
  return {
    core: railway("core-token", core.fetch), workers: railway("workers-token", workers.fetch), environment: "staging", commit: "new", images,
    deployed: async () => null, isAncestor: () => false,
    sleep: async (ms) => void (clock += ms), now: () => clock, log: () => {}, pollMs: 1000, timeoutMs: 10_000, ...over,
  };
}

const mutations = (...fakes: Array<ReturnType<typeof fakeRailway>>) => fakes.flatMap((f) => f.calls).filter((c) => ["environmentPatchCommit", "serviceInstanceDeployV2"].includes(c.op));

test("finishes the migration before the control plane and the runner, then waits for the old runner to go", async () => {
  const core = fakeRailway({ project: "p-core", environment: "e-core", services: coreServices, deployments: {
    migrate: [{ status: "DEPLOYING", deploymentStopped: true, instances: ["RUNNING"] }, exited],
    "control-plane": [{ status: "BUILDING", deploymentStopped: true }, up],
  } });
  const workers = fakeRailway({ project: "p-workers", environment: "e-workers", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["old", "dep-runner"], ["dep-runner"]] });
  await deploy(options(core, workers));

  expect(core.calls.filter((c) => c.op === "environmentPatchCommit").map((c) => [c.variables.env, c.variables.patch])).toEqual([
    ["e-core", { services: { "s-migrate": { source: { image: images.migrate, repo: null, branch: null } } } }],
    ["e-core", { services: { "s-cp": { source: { image: images.controlPlane, repo: null, branch: null } } } }],
  ]);
  expect(workers.calls.filter((c) => c.op === "environmentPatchCommit").map((c) => [c.variables.env, c.variables.patch])).toEqual([
    ["e-workers", { services: { "s-runner": { source: { image: images.runner, repo: null, branch: null } } } }],
  ]);
  const lastMigratePoll = core.calls.map((c) => c.variables.id).lastIndexOf("dep-migrate");
  const controlPlaneSwitch = core.calls.findIndex((c) => c.op === "environmentPatchCommit" && JSON.stringify(c.variables.patch).includes("s-cp"));
  expect(lastMigratePoll).toBeLessThan(controlPlaneSwitch);
  expect(core.calls.filter((c) => c.variables.id === "dep-migrate")).toHaveLength(2);
  expect(workers.calls.filter((c) => c.op === "serviceInstance" && c.variables.svc === "s-runner")).toHaveLength(3);
  expect(core.calls.every((c) => c.token === "core-token")).toBe(true);
  expect(workers.calls.every((c) => c.token === "workers-token")).toBe(true);
  expect(core.calls.filter((c) => "env" in c.variables).every((c) => c.variables.env === "e-core")).toBe(true);
  expect(workers.calls.filter((c) => "env" in c.variables).every((c) => c.variables.env === "e-workers")).toBe(true);
});

test("a token of another Railway environment is refused before anything changes", async () => {
  const core = fakeRailway({ project: "p", environment: "e", environmentName: "production", services: coreServices, deployments: {} });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: {} });
  await expect(deploy(options(core, workers))).rejects.toThrow("RAILWAY_CORE_TOKEN belongs to the Railway environment production, not staging");
  const workersElsewhere = fakeRailway({ project: "p2", environment: "e2", environmentName: "production", services: { runner: "s-runner" }, deployments: {} });
  await expect(deploy(options(fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: {} }), workersElsewhere))).rejects.toThrow("RAILWAY_WORKERS_TOKEN belongs to the Railway environment production, not staging");
  expect(mutations(core, workers, workersElsewhere)).toEqual([]);
});

test("a commit older than the one the environment runs is refused before anything changes", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: {} });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: {} });
  const isAncestor = (older: string, newer: string) => older === "old" && newer === "newer";
  await expect(deploy(options(core, workers, { commit: "old", deployed: async () => "newer", isAncestor }))).rejects.toThrow("staging already runs newer, which is newer than old");
  expect(mutations(core, workers)).toEqual([]);
});

test("the same commit again, a newer one, or an environment that reports no commit is deployed", async () => {
  const isAncestor = (older: string, newer: string) => older === newer || (older === "old" && newer === "newer");
  for (const [commit, running] of [["newer", "newer"], ["newer", "old"], ["old", null]] as const) {
    const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [up] } });
    const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
    await deploy(options(core, workers, { commit, deployed: async () => running, isAncestor }));
    expect(mutations(core, workers)).toHaveLength(6);
  }
});

test("a failed migration stops the release before the control plane or the runner is touched", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [{ status: "CRASHED", deploymentStopped: true, instances: ["CRASHED"] }] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] } });
  await expect(deploy(options(core, workers))).rejects.toThrow(/migrate deployment dep-migrate ended CRASHED/);
  expect(mutations(core, workers).filter((c) => JSON.stringify(c.variables).match(/s-cp|s-runner/))).toEqual([]);
});

test("a migration whose container crashed stops the release, even while Railway still calls the deployment a success", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: {
    migrate: [{ status: "SUCCESS", deploymentStopped: true, instances: ["RESTARTING"] }, { status: "SUCCESS", deploymentStopped: true, instances: ["CRASHED"] }], "control-plane": [up],
  } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow("migrate deployment dep-migrate crashed");
  expect(mutations(core, workers).filter((c) => JSON.stringify(c.variables).match(/s-cp|s-runner/))).toEqual([]);
});

test("a migration Railway reports as stopped without any container is not taken for a finished one", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [{ status: "SUCCESS", deploymentStopped: true, instances: [] }] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] } });
  await expect(deploy(options(core, workers))).rejects.toThrow(/migrate deployment dep-migrate is still SUCCESS$/);
  expect(mutations(core, workers).filter((c) => JSON.stringify(c.variables).match(/s-cp|s-runner/))).toEqual([]);
});

test("a service Railway keeps building from the repository is not deployed", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited] }, keepsRepo: true });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: {} });
  await expect(deploy(options(core, workers))).rejects.toThrow(`Railway did not switch migrate to ${images.migrate}; it still builds from usetrawler/trawler`);
  expect(core.calls.some((c) => c.op === "serviceInstanceDeployV2")).toBe(false);
});

test("a deployment of anything but the released image is cancelled at once", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: {
    migrate: [{ status: "DEPLOYING", deploymentStopped: true, image: "ghcr.io/x/migrate:latest" }, exited],
  } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] } });
  await expect(deploy(options(core, workers))).rejects.toThrow(`migrate deployment dep-migrate runs ghcr.io/x/migrate:latest, not ${images.migrate}`);
  expect(core.calls.filter((c) => c.op === "deploymentCancel").map((c) => c.variables.id)).toEqual(["dep-migrate"]);
  expect(core.calls.filter((c) => c.variables.id === "dep-migrate" && c.op === "deployment")).toHaveLength(1);
});

test("a deployment that never becomes healthy fails the release with its name", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [{ status: "DEPLOYING", deploymentStopped: false, instances: ["RUNNING"] }] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow("control-plane deployment dep-control-plane is still DEPLOYING (RUNNING)");
});

test("a control plane whose container crashed fails the release", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [{ status: "SUCCESS", deploymentStopped: false, instances: ["CRASHED"] }] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow("control-plane deployment dep-control-plane crashed");
});

test("a control plane that keeps restarting is not taken for a running one", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [{ status: "SUCCESS", deploymentStopped: false, instances: ["RESTARTING"] }] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow("control-plane deployment dep-control-plane is still SUCCESS (RESTARTING)");
});

test("a control plane that exited right after it started fails the release at once", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [exited] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow("control-plane deployment dep-control-plane exited instead of running");
  expect(core.calls.filter((c) => c.variables.id === "dep-control-plane")).toHaveLength(1);
});

test("a runner that the old deployment never leaves fails the release", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [up] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["old", "dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow(/runner still has an older deployment running next to dep-runner/);
});

test("a runner whose new deployment is no longer active fails the release at once", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [up] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["old"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow("runner deployment dep-runner is no longer active");
  expect(workers.calls.filter((c) => c.op === "serviceInstance" && c.variables.svc === "s-runner")).toHaveLength(2);
});

test("Railway failing to answer a few polls does not fail the release", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [up] }, failPolls: 2 });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await deploy(options(core, workers));
  expect(core.calls.filter((c) => c.variables.id === "dep-migrate")).toHaveLength(3);
});

test("a project without one of the services is refused before anything changes", async () => {
  for (const [coreSet, workersSet, missing] of [
    [{ web: "s-web" }, { runner: "s-runner" }, "migrate"],
    [{ migrate: "s-migrate" }, { runner: "s-runner" }, "control-plane"],
    [coreServices, { web: "s-web" }, "runner"],
  ] as const) {
    const core = fakeRailway({ project: "p", environment: "e", services: coreSet, deployments: { migrate: [exited], "control-plane": [up] } });
    const workers = fakeRailway({ project: "p2", environment: "e2", services: workersSet, deployments: {} });
    await expect(deploy(options(core, workers))).rejects.toThrow(`no service named ${missing}`);
    expect(mutations(core, workers)).toEqual([]);
  }
});

test("the commit an environment runs is read from its health check, and unknown when it does not answer", async () => {
  const answering = (async () => Response.json({ ok: true, commit: "abc" })) as unknown as typeof globalThis.fetch;
  const silent = (async () => Response.json({ ok: true })) as unknown as typeof globalThis.fetch;
  const down = (async () => { throw new Error("connection refused"); }) as unknown as typeof globalThis.fetch;
  const broken = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof globalThis.fetch;
  expect(await deployedCommit("https://staging.test", answering)).toBe("abc");
  expect(await deployedCommit("https://staging.test", silent)).toBeNull();
  expect(await deployedCommit("https://staging.test", down)).toBeNull();
  expect(await deployedCommit("https://staging.test", broken)).toBeNull();
});

test("a switch Railway applies a moment later is waited for before deploying", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [up] }, lagReads: 2 });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await deploy(options(core, workers));
  const firstDeploy = core.calls.findIndex((c) => c.op === "serviceInstanceDeployV2");
  expect(core.calls.slice(0, firstDeploy).filter((c) => c.op === "serviceInstance")).toHaveLength(3);
});

test("a deployment Railway builds from the repository after all is cancelled at once", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited] }, buildsRepo: true });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: {} });
  await expect(deploy(options(core, workers))).rejects.toThrow(`migrate deployment dep-migrate runs a build of 0ld, not ${images.migrate}`);
  expect(core.calls.filter((c) => c.op === "deploymentCancel").map((c) => c.variables.id)).toEqual(["dep-migrate"]);
});

test("a deployment whose metadata names no image is not taken for the released one", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited] }, noImageMeta: true });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: {} });
  await expect(deploy(options(core, workers))).rejects.toThrow(`migrate deployment dep-migrate runs an unknown image, not ${images.migrate}`);
  expect(mutations(core, workers).filter((c) => JSON.stringify(c.variables).match(/s-cp|s-runner/))).toEqual([]);
});

test("an environment running a commit git does not know is deployed, and the log says so", async () => {
  const lines: string[] = [];
  const core = fakeRailway({ project: "p", environment: "e", services: coreServices, deployments: { migrate: [exited], "control-plane": [up] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await deploy(options(core, workers, { commit: "new", deployed: async () => "gone", isAncestor: () => undefined, log: (line) => lines.push(line) }));
  expect(lines[0]).toBe("staging runs gone, which git does not know; deploying new anyway");
  expect(mutations(core, workers)).toHaveLength(6);
});
