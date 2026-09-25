import { expect, test } from "vitest";
import { deploy, type DeployOptions } from "./deploy.ts";
import { railway } from "./railway.ts";

type Deployment = { status: string; deploymentStopped: boolean; image?: string };

function fakeRailway(opts: { project: string; environment: string; services: Record<string, string>; deployments: Record<string, Deployment[]>; active?: string[][] }) {
  const calls: Array<{ op: string; variables: Record<string, unknown>; token: string | null }> = [];
  const deployed = new Map<string, string>();
  const source = new Map<unknown, unknown>();
  let active = opts.active ?? [];
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(projectToken|project\(|serviceInstanceUpdate|serviceInstanceDeployV2|deployment\(|serviceInstance\()/.exec(query)![1]!;
    calls.push({ op, variables, token: new Headers(init?.headers).get("project-access-token") });
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (op === "projectToken") return reply({ projectToken: { projectId: opts.project, environmentId: opts.environment } });
    if (op === "project(") return reply({ project: { services: { edges: Object.entries(opts.services).map(([name, id]) => ({ node: { id, name } })) } } });
    if (op === "serviceInstanceUpdate") {
      source.set(variables.svc, (variables.input as { source: { image: string } }).source.image);
      return reply({ serviceInstanceUpdate: true });
    }
    if (op === "serviceInstanceDeployV2") {
      const name = Object.entries(opts.services).find(([, id]) => id === variables.svc)![0];
      deployed.set(`dep-${name}`, name);
      return reply({ serviceInstanceDeployV2: `dep-${name}` });
    }
    if (op === "deployment(") {
      const name = deployed.get(String(variables.id))!;
      const queue = opts.deployments[name]!;
      const { image, ...deployment } = (queue.length > 1 ? queue.shift() : queue[0])!;
      return reply({ deployment: { ...deployment, meta: { image: image ?? source.get(opts.services[name]) } } });
    }
    const ids = active.length > 1 ? active.shift()! : active[0] ?? [];
    return reply({ serviceInstance: { activeDeployments: ids.map((id) => ({ id })) } });
  }) as typeof globalThis.fetch;
  return { calls, fetch: fakeFetch };
}

const images = { migrate: "ghcr.io/x/migrate@sha256:1", controlPlane: "ghcr.io/x/control-plane@sha256:2", runner: "ghcr.io/x/runner@sha256:3" };
const up = { status: "SUCCESS", deploymentStopped: false };

function options(core: ReturnType<typeof fakeRailway>, workers: ReturnType<typeof fakeRailway>): DeployOptions {
  let clock = 0;
  return { core: railway("core-token", core.fetch), workers: railway("workers-token", workers.fetch), images, sleep: async (ms) => void (clock += ms), now: () => clock, log: () => {}, pollMs: 1000, timeoutMs: 10_000 };
}

test("finishes the migration before the control plane and the runner, then waits for the old runner to go", async () => {
  const core = fakeRailway({ project: "p-core", environment: "e-core", services: { migrate: "s-migrate", "control-plane": "s-cp", Postgres: "s-pg" }, deployments: {
    migrate: [{ status: "DEPLOYING", deploymentStopped: false }, up, { status: "SUCCESS", deploymentStopped: true }],
    "control-plane": [{ status: "BUILDING", deploymentStopped: false }, up],
  } });
  const workers = fakeRailway({ project: "p-workers", environment: "e-workers", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["old", "dep-runner"], ["dep-runner"]] });
  await deploy(options(core, workers));

  const updates = core.calls.filter((c) => c.op === "serviceInstanceUpdate").map((c) => [c.variables.svc, c.variables.env, c.variables.input]);
  expect(updates).toEqual([["s-migrate", "e-core", { source: { image: images.migrate } }], ["s-cp", "e-core", { source: { image: images.controlPlane } }]]);
  const lastMigratePoll = core.calls.map((c) => c.variables.id).lastIndexOf("dep-migrate");
  const controlPlaneUpdate = core.calls.findIndex((c) => c.op === "serviceInstanceUpdate" && c.variables.svc === "s-cp");
  expect(lastMigratePoll).toBeLessThan(controlPlaneUpdate);
  expect(core.calls.filter((c) => c.variables.id === "dep-migrate")).toHaveLength(3);
  expect(workers.calls.filter((c) => c.op === "serviceInstanceUpdate").map((c) => c.variables.input)).toEqual([{ source: { image: images.runner } }]);
  expect(workers.calls.filter((c) => c.op === "serviceInstance(")).toHaveLength(2);
  expect(core.calls.every((c) => c.token === "core-token")).toBe(true);
  expect(workers.calls.every((c) => c.token === "workers-token")).toBe(true);
});

test("a failed migration stops the release before the control plane or the runner is touched", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: { migrate: "s-migrate", "control-plane": "s-cp" }, deployments: { migrate: [{ status: "CRASHED", deploymentStopped: true }] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] } });
  await expect(deploy(options(core, workers))).rejects.toThrow(/migrate deployment dep-migrate ended CRASHED/);
  expect(core.calls.some((c) => c.op === "serviceInstanceUpdate" && c.variables.svc === "s-cp")).toBe(false);
  expect(workers.calls.some((c) => c.op === "serviceInstanceUpdate")).toBe(false);
});

test("a deployment that never becomes healthy fails the release with its name", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: { migrate: "s-migrate", "control-plane": "s-cp" }, deployments: {
    migrate: [{ status: "SUCCESS", deploymentStopped: true }], "control-plane": [{ status: "DEPLOYING", deploymentStopped: false }],
  } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow(/control-plane deployment dep-control-plane is still DEPLOYING/);
});

test("a runner that the old deployment never leaves fails the release", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: { migrate: "s-migrate", "control-plane": "s-cp" }, deployments: { migrate: [{ status: "SUCCESS", deploymentStopped: true }], "control-plane": [up] } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["old", "dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow(/runner still has an older deployment running/);
});

test("a token for a project without the expected services is refused before anything is deployed", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: { web: "s-web" }, deployments: {} });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: {} });
  await expect(deploy(options(core, workers))).rejects.toThrow(/no service named migrate/);
  expect([...core.calls, ...workers.calls].some((c) => c.op === "serviceInstanceUpdate")).toBe(false);
});

test("a deployment that runs some other image than the one released fails the release", async () => {
  const core = fakeRailway({ project: "p", environment: "e", services: { migrate: "s-migrate", "control-plane": "s-cp" }, deployments: {
    migrate: [{ status: "SUCCESS", deploymentStopped: true, image: "ghcr.io/x/migrate:latest" }], "control-plane": [up],
  } });
  const workers = fakeRailway({ project: "p2", environment: "e2", services: { runner: "s-runner" }, deployments: { runner: [up] }, active: [["dep-runner"]] });
  await expect(deploy(options(core, workers))).rejects.toThrow("migrate deployment dep-migrate runs ghcr.io/x/migrate:latest, not ghcr.io/x/migrate@sha256:1");
  expect(core.calls.some((c) => c.op === "serviceInstanceUpdate" && c.variables.svc === "s-cp")).toBe(false);
});
