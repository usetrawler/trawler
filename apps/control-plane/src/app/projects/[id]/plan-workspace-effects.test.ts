import { beforeEach, expect, test, vi } from "vitest";
import type { Persona } from "@usetrawler/protocol";

const react = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>>,
  started: [] as Array<Promise<unknown>>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const set = vi.fn();
    react.setters.push(set);
    return [react.values.length ? react.values.shift() : initial, set];
  },
  useEffect: () => {},
  useTransition: () => [false, (work: () => Promise<unknown>) => { react.started.push(work()); }],
}));
const actions = vi.hoisted(() => ({ savePlanAction: vi.fn(), addAccountAction: vi.fn(), removeAccountAction: vi.fn() }));
vi.mock("./plan-actions.ts", () => actions);
vi.mock("./start-run.tsx", () => ({ StartRun: () => null }));

const { Accounts, PlanWorkspace } = await import("./plan-workspace.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text((node as Node).props?.children ?? "") : "");

const ama: Persona = { id: "ama", name: "Ama", brief: "Brand new." };
const goals = [{ id: "g", instruction: "Send an invoice." }];
const account = { ref: "account-1", username: "kwame@acme.test", hint: "…1234" };
const outdated = () => new UnrecognizedActionError("Server action not found.");

beforeEach(() => {
  Object.assign(react, { values: [], setters: [], started: [] });
  for (const action of Object.values(actions)) action.mockReset();
});

const changedPlan = () => {
  react.values = [{ personas: [ama], goals }, [{ ...ama, name: "Ama Mensah" }], goals, [], null];
  const tree = PlanWorkspace({ projectId: "p1", projectName: "Acme", initialPersonas: [ama], initialGoals: goals, initialAccounts: [], keyHint: null, canManageKey: true, authorisedBefore: true });
  const [setSaved, setPersonas, setGoals, , setError] = react.setters;
  const save = nodes(tree).find((node) => node.type === "button" && text(node) === "Save plan")!;
  return { save: () => (save.props!.onClick as () => void)(), setSaved: setSaved!, setPersonas: setPersonas!, setGoals: setGoals!, setError: setError! };
};

const accounts = () => {
  const onChange = vi.fn();
  const tree = Accounts({ projectId: "p1", accounts: [account], anyoneWithout: false, onChange });
  const [, setUsername, setPassword, setError] = react.setters;
  const add = () => (nodes(tree).find((node) => node.type === "form")!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  const remove = () => (nodes(tree).find((node) => node.props?.label === "Remove kwame@acme.test")!.props!.onClick as () => void)();
  return { add, remove, onChange, setUsername: setUsername!, setPassword: setPassword!, setError: setError! };
};

test("Save plan on a page left open across an update says the changes cannot be saved from it, and leaves them on screen to copy", async () => {
  actions.savePlanAction.mockRejectedValue(outdated());
  const plan = changedPlan();
  plan.save();
  await Promise.all(react.started);
  expect(actions.savePlanAction).toHaveBeenCalledWith("p1", { personas: [{ ...ama, name: "Ama Mensah" }], goals });
  expect(plan.setError).toHaveBeenLastCalledWith("Trawler has been updated since this page opened. Copy your changes, reload the page, then make them again and save.");
  expect(plan.setSaved).not.toHaveBeenCalled();
  expect(plan.setPersonas).not.toHaveBeenCalled();
  expect(plan.setGoals).not.toHaveBeenCalled();
});

test("any other failure of Save plan goes on to the error page as before", async () => {
  const failure = new TypeError("Failed to fetch");
  actions.savePlanAction.mockRejectedValue(failure);
  const plan = changedPlan();
  plan.save();
  await expect(react.started[0]).rejects.toBe(failure);
  expect(plan.setError).not.toHaveBeenCalled();
});

test("adding or removing a test account on a page left open across an update says to reload, and changes nothing", async () => {
  actions.addAccountAction.mockRejectedValue(outdated());
  actions.removeAccountAction.mockRejectedValue(outdated());
  const panel = accounts();
  panel.add();
  await Promise.all(react.started);
  expect(actions.addAccountAction).toHaveBeenCalledWith("p1", { username: "", password: "" });
  expect(panel.setError).toHaveBeenLastCalledWith("Trawler has been updated since this page opened. Reload the page to add the account.");
  panel.remove();
  await Promise.all(react.started);
  expect(actions.removeAccountAction).toHaveBeenCalledWith("p1", "account-1");
  expect(panel.setError).toHaveBeenLastCalledWith("Trawler has been updated since this page opened. Reload the page to remove the account.");
  expect(panel.onChange).not.toHaveBeenCalled();
  expect(panel.setUsername).not.toHaveBeenCalled();
  expect(panel.setPassword).not.toHaveBeenCalled();
});

test("any other failure of adding or removing a test account goes on to the error page as before", async () => {
  const failure = new TypeError("Failed to fetch");
  actions.addAccountAction.mockRejectedValue(failure);
  actions.removeAccountAction.mockRejectedValue(failure);
  const panel = accounts();
  panel.add();
  await expect(react.started[0]).rejects.toBe(failure);
  panel.remove();
  await expect(react.started[1]).rejects.toBe(failure);
  expect(panel.setError).not.toHaveBeenCalled();
});

test("an account the server adds or removes still reaches the plan", async () => {
  actions.addAccountAction.mockResolvedValue({ ok: true, accounts: [account], ref: "account-1" });
  actions.removeAccountAction.mockResolvedValue({ ok: true, accounts: [] });
  const panel = accounts();
  panel.add();
  await Promise.all(react.started);
  expect(panel.onChange).toHaveBeenLastCalledWith([account]);
  panel.remove();
  await Promise.all(react.started);
  expect(panel.onChange).toHaveBeenLastCalledWith([], "account-1");
});
