import type { ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ state: {} as Record<string, unknown>, states: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateAt: 0, refAt: 0, setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>> }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: () => [react.state, () => {}, false],
  useState: (initial: unknown) => {
    const at = react.stateAt++;
    const set = vi.fn();
    react.setters[at] = set;
    return [at < react.states.length ? react.states[at] : initial, set];
  },
  useRef: (initial: unknown) => (react.refs[react.refAt++] ??= { current: initial }),
  useEffect: () => {},
}));
vi.mock("./actions.ts", () => ({ startRunAction: vi.fn(), modelsForKeyAction: vi.fn(), priceRangeAction: vi.fn() }));

const { StartRun } = await import("./start-run.tsx");
const { KeyFields } = await import("../../../components/key-fields.tsx");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [element, ...nodes(element.props?.children), ...nodes(element.props?.aside)];
};
const keyHint = { provider: "openrouter" as const, hint: "…a1b2", baseUrl: null };
const draw = (options: { replacing?: boolean; hint?: typeof keyHint | null } = {}) => {
  react.stateAt = 0;
  react.refAt = 0;
  react.states = options.replacing === undefined ? [] : [options.replacing];
  return nodes(StartRun({ projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: options.hint === undefined ? keyHint : options.hint, canManageKey: true, authorisedBefore: true }) as ReactElement);
};
const offer = true;
const drawOffer = (payingOwn: boolean, hint: typeof keyHint | null = null) => {
  react.stateAt = 0;
  react.refAt = 0;
  react.states = [false, "", null, "", null, false, "", null, 2, false, payingOwn];
  return nodes(StartRun({ projectId: "p1", planId: "pl1", projectName: "Acme Invoices", personas: 2, keyHint: hint, canManageKey: true, authorisedBefore: true, firstRunOnUs: offer }) as ReactElement);
};
const keyFields = (tree: Node[]) => tree.find((n) => n.type === KeyFields)?.props;
const button = (tree: Node[], text: RegExp) => tree.find((n) => n.type === "button" && text.test([n.props?.children].flat().join("")))?.props;

beforeEach(() => {
  Object.assign(react, { state: {}, states: [], refs: [], setters: [] });
});

test("Replace opens the key fields with the cursor in the key field; a workspace without a key does not take the page's focus", () => {
  expect(keyFields(draw({ replacing: true }))?.autoFocus).toBe(true);
  expect(keyFields(draw({ hint: null }))?.autoFocus).toBe(false);
});

test("Keep closes the fields and puts focus back on Replace, once, and a page that simply loads leaves focus alone", () => {
  const focus = vi.fn();
  const attach = (tree: Node[]) => (button(tree, /^Replace$/)!.ref as (el: { focus: () => void } | null) => void)({ focus });
  attach(draw());
  expect(focus).not.toHaveBeenCalled();

  const keep = button(draw({ replacing: true }), /^Keep /)!;
  (keep.onClick as () => void)();
  expect(react.setters[0]).toHaveBeenCalledWith(false);
  attach(draw({ replacing: false }));
  expect(focus).toHaveBeenCalledOnce();
  attach(draw({ replacing: false }));
  expect(focus).toHaveBeenCalledOnce();
});

test("a refusal about the key or the base URL is tied to that field, and the message has the id they point to", () => {
  react.state = { error: "OpenRouter did not accept this key.", field: "key" };
  let tree = draw({ replacing: true });
  expect(keyFields(tree)).toMatchObject({ errorId: "start-error", baseUrlErrorId: undefined });
  expect(tree.find((n) => n.props?.role === "alert")?.props?.id).toBe("start-error");
  react.state = { error: "The base URL must start with https://.", field: "baseUrl" };
  expect(keyFields(draw({ replacing: true }))).toMatchObject({ errorId: undefined, baseUrlErrorId: "start-error" });
  react.state = { error: "Set a cap between $0.10 and $50." };
  tree = draw({ replacing: true });
  expect(keyFields(tree)).toMatchObject({ errorId: undefined, baseUrlErrorId: undefined });
});

test("paying with one's own key swaps the first run on Trawler for the key form, the way back restores it, and focus follows to the button that undoes the switch", () => {
  const focus = vi.fn();
  const attach = (props: Record<string, unknown>) => (props.ref as (el: { focus: () => void } | null) => void)({ focus });
  const offered = drawOffer(false);
  const offersOnUs = (tree: Node[]) => tree.some((n) => typeof n.type === "function" && n.type.name === "OnUs");
  expect(offersOnUs(offered)).toBe(true);
  const submit = (tree: Node[]) => tree.find((n) => typeof n.type === "function" && n.type.name === "Submit")?.props;
  expect(submit(offered)?.checksKey).toBe(false);
  expect(keyFields(offered)).toBeUndefined();
  const payOwn = button(offered, /^Pay with your own model key instead$/)!;
  attach(payOwn);
  expect(focus).not.toHaveBeenCalled();
  (payOwn.onClick as () => void)();
  expect(react.setters[10]).toHaveBeenCalledWith(true);

  const own = drawOffer(true);
  expect(offersOnUs(own)).toBe(false);
  expect(submit(own)?.checksKey).toBe(true);
  expect(keyFields(own)).toBeDefined();
  const back = button(own, /^Use the first run on Trawler instead$/)!;
  attach(back);
  expect(focus).toHaveBeenCalledOnce();
  (back.onClick as () => void)();
  expect(react.setters[10]).toHaveBeenCalledWith(false);
  attach(button(drawOffer(false), /^Pay with your own model key instead$/)!);
  expect(focus).toHaveBeenCalledTimes(2);
  attach(button(drawOffer(false), /^Pay with your own model key instead$/)!);
  expect(focus).toHaveBeenCalledTimes(2);
});
