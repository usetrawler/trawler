import { beforeEach, expect, test, vi } from "vitest";

type Ref = { current: { focus: () => void } | null };
const react = vi.hoisted(() => ({
  panel: { step: "view", status: "", refusal: null, focus: null } as Record<string, unknown>,
  results: [] as unknown[],
  refs: [] as Ref[],
  deps: [] as Array<unknown[] | undefined>,
  dispatched: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useReducer: () => [react.panel, (event: unknown) => { react.dispatched.push(event); }],
  useActionState: () => [react.results.shift() ?? {}, () => {}, false],
  useEffect: (effect: () => void, deps?: unknown[]) => { react.deps.push(deps); effect(); },
  useRef: () => react.refs.shift() ?? { current: null },
  useState: (initial: unknown) => [initial, () => {}],
}));
vi.mock("./actions.ts", () => ({ renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}) }));

const { ModelKey, RemoveForm, ReplaceForm } = await import("./model-key.tsx");
const saved = { provider: "openrouter" as const, hint: "…a1b2", baseUrl: null, addedAt: "2026-09-25T18:50:00.000Z" };
const focusable = () => ({ current: { focus: vi.fn() } });
const draw = (replaced: unknown, removed: unknown) => {
  react.results = [replaced, removed];
  ModelKey({ saved, addedBy: null, canManage: true });
};

type Node = { type?: unknown; props?: { children?: unknown; aside?: unknown; ref?: unknown; onClick?: () => void; onSubmit?: () => void } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [element, ...nodes(element.props?.children), ...nodes(element.props?.aside)];
};
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : text((node as Node | null)?.props?.children ?? ""));
const button = (tree: unknown, label: RegExp) => nodes(tree).find((node) => node.type === "button" && label.test(text(node)))!;

beforeEach(() => {
  react.panel = { step: "view", status: "", refusal: null, focus: null };
  react.results = [];
  react.refs = [];
  react.deps = [];
  react.dispatched = [];
});

test("a saved key's answer takes the panel back to Replace and says so", () => {
  draw({ saved: true, unchecked: false }, {});
  expect(react.dispatched).toEqual([{ type: "back", to: "replace", status: "Key saved." }]);
});

test("a removal's answer, or finding the key already gone, lands on the section heading with what happened", () => {
  draw({}, { saved: true, stoppedRuns: 2 });
  draw({}, { saved: true, stoppedRuns: 0, alreadyRemoved: true });
  expect(react.dispatched).toEqual([
    { type: "back", to: "heading", status: "Key removed. The 2 runs that were going are stopped." },
    { type: "back", to: "heading", status: "The key was already removed." },
  ]);
});

test("a refusal keeps its step and shows its reason, marked with the step it came from", () => {
  draw({ error: "OpenRouter refused this key.", field: "key" }, {});
  draw({}, { error: "The key changed since this page was loaded, so it was not removed. The page now shows the current key." });
  expect(react.dispatched).toEqual([
    { type: "refused", refusal: { from: "replace", error: "OpenRouter refused this key.", field: "key" } },
    { type: "refused", refusal: { from: "remove", error: "The key changed since this page was loaded, so it was not removed. The page now shows the current key." } },
  ]);
});

test("each answer is handled once, when it arrives, and focus is looked at after every render", () => {
  const replaced = { saved: true };
  const removed = { error: "E" };
  draw(replaced, removed);
  expect(react.deps).toEqual([undefined, [replaced], [removed]]);
  expect(react.deps[1]![0]).toBe(replaced);
  expect(react.deps[2]![0]).toBe(removed);
});

test("focus goes where the panel points, and the panel then forgets the target", () => {
  const [heading, replace, remove] = [focusable(), focusable(), focusable()];
  react.refs = [heading, replace, remove];
  react.panel = { step: "view", status: "Key saved.", refusal: null, focus: "replace" };
  draw({}, {});
  expect([heading, replace, remove].map((ref) => vi.mocked(ref.current.focus).mock.calls.length)).toEqual([0, 1, 0]);
  expect(react.dispatched).toEqual([{ type: "focused" }]);
});

test("the remove step opens on Keep the key, so a second Enter keeps the key", () => {
  const keep = focusable();
  react.refs = [keep];
  const form = RemoveForm({ addedAt: saved.addedAt, action: () => {}, pending: false, error: "", onSent: () => {}, onKeep: () => {} });
  expect(keep.current.focus).toHaveBeenCalledOnce();
  expect(nodes(form).filter((node) => node.props?.ref === keep).map(text)).toEqual(["Keep the key"]);
});

test("while a check or a removal runs, Keep does nothing; once it is over, Keep leaves the step", () => {
  const kept = vi.fn();
  const removal = (pending: boolean) => RemoveForm({ addedAt: saved.addedAt, action: () => {}, pending, error: "", onSent: () => {}, onKeep: kept });
  const replacing = (pending: boolean) => ReplaceForm({ saved, action: () => {}, pending, refusal: null, onSent: () => {}, onKeep: kept });
  button(removal(true), /^Keep the key$/).props!.onClick!();
  button(replacing(true), /^Keep …a1b2$/).props!.onClick!();
  expect(kept).not.toHaveBeenCalled();
  button(removal(false), /^Keep the key$/).props!.onClick!();
  button(replacing(false), /^Keep …a1b2$/).props!.onClick!();
  expect(kept).toHaveBeenCalledTimes(2);
});

test("sending a form tells the panel at once, before its answer arrives", () => {
  const sent = vi.fn();
  expect(ReplaceForm({ saved, action: () => {}, pending: false, refusal: null, onSent: sent, onKeep: () => {} }).props.onSubmit).toBe(sent);
  expect(RemoveForm({ addedAt: saved.addedAt, action: () => {}, pending: false, error: "", onSent: sent, onKeep: () => {} }).props.onSubmit).toBe(sent);
});

test("a removal's refusal never shows in the key form, and a key refusal never in the removal step", () => {
  react.panel = { step: "confirming", status: "", refusal: { from: "remove", error: "E" }, focus: null };
  react.results = [{}, {}];
  const withoutKey = ModelKey({ saved: null, addedBy: null, canManage: true });
  expect(nodes(withoutKey).find((node) => node.type === ReplaceForm)?.props).toMatchObject({ refusal: null });
  react.panel = { step: "confirming", status: "", refusal: { from: "replace", error: "E" }, focus: null };
  react.results = [{}, {}];
  const withKey = ModelKey({ saved, addedBy: null, canManage: true });
  expect(nodes(withKey).find((node) => node.type === RemoveForm)?.props).toMatchObject({ error: "" });
});
