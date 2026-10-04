import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ planCount: 1, wizard: [] as Array<Record<string, unknown>> }));
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const member = { userId: "u1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme workspace", role: "member" };

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); },
  notFound: () => { throw Object.assign(new Error("not found"), { notFound: true }); },
}));
vi.mock("../../../../../server/auth.ts", () => ({ signedInMember: async () => member }));
vi.mock("../../../../../server/shell.ts", () => ({ shellFor: async () => ({ user: { name: "Ana", email: member.email }, workspace: { name: "Acme workspace", projects: [{ id: ID, name: "Acme", address: "app.acme.test" }], runs: 0 } }) }));
vi.mock("../../../../../server/db.ts", () => ({ getDb: () => ({}) }));
vi.mock("../../../../../db/tenancy.ts", () => ({ withOrg: async (_db: unknown, _org: string, work: (tx: unknown) => unknown) => work({}) }));
vi.mock("../../../../../projects/overview.ts", () => ({ hostOf: (u: string) => new URL(u).host, projectRunCount: async () => 0 }));
vi.mock("../../../../../runs/runs.ts", () => ({ projectRunState: async () => ({ paused: false, liveRun: null }) }));
vi.mock("../../../../../projects/projects.ts", () => ({
  MAX_PLANS: 10,
  projectForEditing: async (_tx: unknown, _org: string, id: string) => ({ id, name: "Acme", target_url: "https://app.acme.test/", description: "Invoices." }),
  listPlans: async () => Array.from({ length: state.planCount }, (_, i) => ({ id: `plan-${i}`, name: `Plan ${i + 1}`, features: [], people: 1 })),
  nextPlanName: async () => `Plan ${state.planCount + 1}`,
}));
vi.mock("../../../../../server/titles.ts", () => ({ projectPageTitle: async () => ({}) }));
vi.mock("../../../../new/setup-wizard.tsx", () => ({ SetupWizard: (props: Record<string, unknown>) => { state.wizard.push(props); return null; } }));

const { default: NewPlanPage } = await import("./page.tsx");
const render = async () => renderToStaticMarkup(await NewPlanPage({ params: Promise.resolve({ id: ID }) }));

beforeEach(() => {
  state.planCount = 1;
  state.wizard = [];
});

test("adding a plan opens the setup wizard on the project with the next free name, ready to be edited", async () => {
  await render();
  expect(state.wizard).toEqual([expect.objectContaining({ projectId: ID, newPlanName: "Plan 2", projectHost: "app.acme.test", initialDescription: "Invoices." })]);
  state.planCount = 4;
  await render();
  expect(state.wizard.at(-1)).toMatchObject({ newPlanName: "Plan 5" });
});

test("at ten plans there is no wizard, only the reason", async () => {
  state.planCount = 10;
  const html = await render();
  expect(state.wizard).toEqual([]);
  expect(html).toContain("A project holds at most 10 plans. Remove one to add another.");
});
