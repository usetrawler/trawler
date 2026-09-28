import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Persona } from "@usetrawler/protocol";

const react = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>>,
  started: [] as Array<Promise<unknown>>,
  effects: [] as Array<() => unknown>,
  started_props: [] as Array<Record<string, unknown>>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const set = vi.fn();
    react.setters.push(set);
    return [react.values.length ? react.values.shift() : initial, set];
  },
  useEffect: (effect: () => unknown) => { react.effects.push(effect); },
  useTransition: () => [false, (work: () => Promise<unknown>) => { react.started.push(work()); }],
}));
const actions = vi.hoisted(() => ({ savePlanAction: vi.fn(), addAccountAction: vi.fn(), removeAccountAction: vi.fn() }));
vi.mock("./plan-actions.ts", () => actions);
vi.mock("./start-run.tsx", () => ({ StartRun: (props: Record<string, unknown>) => { react.started_props.push(props); return null; } }));

const { PlanWorkspace, SignIn } = await import("./plan-workspace.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text((node as Node).props?.children ?? "") : "");

const ama: Persona = { id: "ama", name: "Ama", brief: "Brand new." };
const goals = [{ id: "g", instruction: "Send an invoice.", personaId: "ama" }];
const account = { ref: "account-1", username: "kwame@acme.test", hint: "…1234" };
const outdated = () => new UnrecognizedActionError("Server action not found.");

beforeEach(() => {
  Object.assign(react, { values: [], setters: [], started: [], effects: [], started_props: [] });
  for (const action of Object.values(actions)) action.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const startBlocked = (tree: unknown) => nodes(tree).find((node) => node.props && "canManageKey" in node.props)!.props!.blocked;

const changedPlan = (changed = { ...ama, name: "Ama Mensah" }) => {
  react.values = [{ personas: [ama], goals }, [changed], goals, [], null];
  const tree = PlanWorkspace({ projectId: "p1", projectName: "Acme", initialPersonas: [ama], initialGoals: goals, initialAccounts: [], keyHint: null, canManageKey: true, authorisedBefore: true });
  const [setSaved, setPersonas, setGoals, , setError] = react.setters;
  const settle = () => { for (const effect of react.effects.splice(0)) effect(); };
  return { tree, settle, setSaved: setSaved!, setPersonas: setPersonas!, setGoals: setGoals!, setError: setError! };
};

const accounts = () => {
  vi.useRealTimers();
  react.values = [true];
  const onChange = vi.fn();
  const onPick = vi.fn();
  const tree = SignIn({ projectId: "p1", person: { ...ama, accountRef: "account-1", signsIn: true }, accounts: [account], onPick, onAccounts: onChange });
  const [setAdding, setUsername, setPassword, setError] = react.setters;
  const add = () => (nodes(tree).find((node) => node.type === "form")!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  const remove = () => (nodes(tree).find((node) => node.type === "button" && text(node) === "Remove kwame@acme.test from the project")!.props!.onClick as () => void)();
  return { add, remove, onChange, onPick, setAdding: setAdding!, setUsername: setUsername!, setPassword: setPassword!, setError: setError! };
};

test("a change saves itself shortly after the last edit, and Start waits for it", async () => {
  actions.savePlanAction.mockResolvedValue({ ok: true });
  const plan = changedPlan();
  plan.settle();
  expect(startBlocked(plan.tree)).toBe("Saving your changes to the plan…");
  vi.advanceTimersByTime(799);
  expect(actions.savePlanAction).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  await Promise.all(react.started);
  expect(actions.savePlanAction).toHaveBeenCalledWith("p1", { personas: [{ ...ama, name: "Ama Mensah" }], goals });
  expect(plan.setSaved).toHaveBeenLastCalledWith({ personas: [{ ...ama, name: "Ama Mensah" }], goals });
  expect(nodes(plan.tree).some((node) => text(node) === "Save plan")).toBe(false);
});

test("a plan that is not valid yet is not saved; the status and Start say what is missing", () => {
  const plan = changedPlan({ ...ama, name: " " });
  plan.settle();
  vi.advanceTimersByTime(5000);
  expect(actions.savePlanAction).not.toHaveBeenCalled();
  expect(startBlocked(plan.tree)).toBe("Person 1 needs a name.");
  expect(nodes(plan.tree).some((node) => node.props?.["aria-live"] === "polite" && text(node).includes("Person 1 needs a name."))).toBe(true);
});

test("a save from a page left open across an update says to reload, and keeps the changes on screen", async () => {
  actions.savePlanAction.mockRejectedValue(outdated());
  const plan = changedPlan();
  plan.settle();
  vi.advanceTimersByTime(800);
  await Promise.all(react.started);
  expect(plan.setError).toHaveBeenLastCalledWith("Trawler has been updated since this page opened. Reload the page to keep editing; your last change was not saved.");
  expect(plan.setSaved).not.toHaveBeenCalled();
  expect(plan.setPersonas).not.toHaveBeenCalled();
  expect(plan.setGoals).not.toHaveBeenCalled();
});

test("any other failure of saving goes on to the error page as before", async () => {
  const failure = new TypeError("Failed to fetch");
  actions.savePlanAction.mockRejectedValue(failure);
  const plan = changedPlan();
  plan.settle();
  vi.advanceTimersByTime(800);
  await expect(react.started[0]).rejects.toBe(failure);
  expect(plan.setError).not.toHaveBeenCalled();
});

test("an account removed meanwhile is taken off the person and the save tries again on its own", async () => {
  actions.savePlanAction.mockResolvedValue({ ok: false, error: "An account you picked was removed.", accounts: [] });
  const plan = changedPlan({ ...ama, name: "Ama Mensah", accountRef: "account-gone", signsIn: true });
  plan.settle();
  vi.advanceTimersByTime(800);
  await Promise.all(react.started);
  expect(plan.setError).not.toHaveBeenCalled();
  const detach = plan.setPersonas.mock.calls.at(-1)![0] as (list: unknown[]) => unknown[];
  expect(detach([{ ...ama, accountRef: "account-gone", signsIn: true }])).toEqual([{ ...ama, accountRef: undefined, signsIn: true }]);
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
  expect(panel.onPick).not.toHaveBeenCalled();
  expect(panel.setAdding).not.toHaveBeenCalled();
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

test("an account added on a card reaches the plan and becomes that person's, and a removed one leaves it", async () => {
  actions.addAccountAction.mockResolvedValue({ ok: true, accounts: [account], ref: "account-1" });
  actions.removeAccountAction.mockResolvedValue({ ok: true, accounts: [] });
  const panel = accounts();
  panel.add();
  await Promise.all(react.started);
  expect(panel.onChange).toHaveBeenLastCalledWith([account]);
  expect(panel.onPick).toHaveBeenLastCalledWith({ accountRef: "account-1", signsIn: true });
  expect(panel.setAdding).toHaveBeenLastCalledWith(false);
  panel.remove();
  await Promise.all(react.started);
  expect(panel.onChange).toHaveBeenLastCalledWith([], "account-1");
});
