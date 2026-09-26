import { beforeEach, expect, test, vi } from "vitest";

type Ref = { current: unknown };
const react = vi.hoisted(() => ({
  flow: { sent: null, confirming: null, focus: null } as Record<string, unknown>,
  results: [] as Array<[unknown, boolean]>,
  refs: [] as Ref[],
  deps: [] as Array<unknown[] | undefined>,
  dispatched: [] as unknown[],
  set: [] as unknown[],
  formPending: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useReducer: () => [react.flow, (event: unknown) => { react.dispatched.push(event); }],
  useActionState: () => { const [result, pending] = react.results.shift() ?? [{}, false]; return [result, () => {}, pending]; },
  useEffect: (effect: () => void, deps?: unknown[]) => { react.deps.push(deps); effect(); },
  useRef: (initial: unknown) => react.refs.shift() ?? { current: initial },
  useState: (initial: unknown) => [initial, (value: unknown) => { react.set.push(value); }],
  startTransition: (work: () => void) => work(),
}));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), useFormStatus: () => ({ pending: react.formPending }) }));
vi.mock("./actions.ts", () => ({ inviteMemberAction: async () => ({}), revokeInvitationAction: async () => ({}), removeMemberAction: async () => ({}), changeRoleAction: async () => ({}) }));

const { ConfirmRemoval, InviteForm, Members } = await import("./members.tsx");
const lee = { id: "m-2", name: "Lee", email: "lee@acme.test", role: "member", joinedAt: "2026-09-21T10:00:00.000Z", you: false };
const heading = { focus: vi.fn() };
const body = {};
const page = { activeElement: body as unknown, body };
vi.stubGlobal("document", page);

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [element, ...nodes(element.props?.children)];
};
const draw = (results: Array<[unknown, boolean]>, flow: Record<string, unknown> = {}) => {
  react.results = [...results];
  react.flow = { sent: null, confirming: null, focus: null, ...flow };
  react.refs = [{ current: heading }, { current: buttons }];
  return nodes(Members({ members: [lee], invitations: [{ id: "inv-1", email: "max@acme.test", role: "member", expiresAt: "2026-10-03T10:00:00.000Z" }], canManage: true, signInAt: "app.usetrawler.test" }));
};
const idle = (): Array<[unknown, boolean]> => [[{}, false], [{}, false], [{}, false], [{}, false]];
let buttons = new Map<string, { focus: () => void }>();

beforeEach(() => {
  react.dispatched = [];
  react.deps = [];
  react.set = [];
  heading.focus.mockClear();
  buttons = new Map();
  page.activeElement = body;
});

test("the answer to what was sent is handled once, when it arrives, with whether it left focus nowhere", () => {
  const before = {};
  const removed = { done: "Lee is removed from this workspace." };
  const results = idle();
  results[1] = [removed, false];
  draw(results, { sent: { change: "remove", before } });
  expect(react.dispatched).toEqual([{ type: "answered", change: "remove", result: removed, focusLost: true }]);
  expect(react.deps).toEqual([undefined, [results[0]![0]], [removed], [results[2]![0]]]);
  page.activeElement = { tagName: "INPUT" };
  react.dispatched = [];
  const again = idle();
  again[1] = [removed, false];
  draw(again, { sent: { change: "remove", before } });
  expect(react.dispatched).toEqual([{ type: "answered", change: "remove", result: removed, focusLost: false }]);
});

test("an answer that is not new, or not to what was sent, is not handled", () => {
  const before = {};
  const results = idle();
  results[1] = [before, false];
  results[0] = [{ done: "Lee is now an admin." }, false];
  draw(results, { sent: { change: "remove", before } });
  expect(react.dispatched).toEqual([]);
});

test("focus moves to the heading, or back to the Remove button Keep came from, and is then marked as moved", () => {
  draw(idle(), { focus: "heading" });
  expect(heading.focus).toHaveBeenCalledTimes(1);
  const remove = { focus: vi.fn() };
  buttons.set("m-2", remove);
  draw(idle(), { focus: { remove: "m-2" } });
  expect(remove.focus).toHaveBeenCalledTimes(1);
  expect(react.dispatched).toEqual([{ type: "focused" }, { type: "focused" }]);
});

test("each list form says what it sent, with the answer it replaces, and Remove opens the confirmation unless something is being sent", () => {
  const results = idle();
  const tree = draw(results);
  const forms = tree.filter((n) => n.type === "form");
  for (const form of forms) (form.props!.onSubmit as () => void)();
  const remove = tree.find((n) => n.type === "button" && typeof n.props?.ref === "function")!;
  (remove.props!.onClick as () => void)();
  expect(react.dispatched).toEqual([
    { type: "sent", change: "change", before: results[0]![0] },
    { type: "sent", change: "revoke", before: results[2]![0] },
    { type: "confirm", id: "m-2" },
  ]);
  const element = { focus: vi.fn() };
  (remove.props!.ref as (e: unknown) => void)(element);
  expect(buttons.get("m-2")).toBe(element);
  (remove.props!.ref as (e: unknown) => void)(null);
  expect(buttons.has("m-2")).toBe(false);
  react.dispatched = [];
  const sending = idle();
  sending[2] = [{}, true];
  const held = draw(sending).find((n) => n.type === "button" && typeof n.props?.ref === "function")!;
  (held.props!.onClick as () => void)();
  expect(react.dispatched).toEqual([]);
});

test("the button of the form being sent says what it is doing, and the others keep their words", () => {
  const submits = draw(idle()).filter((n) => typeof n.type === "function" && n.props?.working);
  const labels = (pending: boolean) => {
    react.formPending = pending;
    return submits.map((n) => (n.type as (props: unknown) => { props: { children: unknown } })(n.props).props.children);
  };
  expect(labels(true)).toEqual(["Changing…", "Revoking…"]);
  expect(labels(false)).toEqual(submits.map((n) => n.props!.children));
  react.formPending = false;
});

test("the confirmation says what it sent, and Keep goes back to that row", () => {
  const results = idle();
  const confirm = draw(results, { confirming: "m-2" }).find((n) => n.type === ConfirmRemoval)!;
  (confirm.props!.onSent as () => void)();
  (confirm.props!.onKeep as () => void)();
  expect(react.dispatched).toEqual([{ type: "sent", change: "remove", before: results[1]![0] }, { type: "keep", id: "m-2" }]);
});

test("the confirmation puts focus on Keep when it opens, and Keep waits while something is sent", () => {
  const keep = { focus: vi.fn() };
  const onKeep = vi.fn();
  react.refs = [{ current: keep }];
  const tree = nodes(ConfirmRemoval({ member: lee, action: () => {}, held: true, removing: false, onSent: () => {}, onKeep }));
  expect(keep.focus).toHaveBeenCalledTimes(1);
  (tree.find((n) => n.type === "button" && n.props?.type === "button")!.props!.onClick as () => void)();
  expect(onKeep).not.toHaveBeenCalled();
});

test("the invite form sends through a transition, so React does not reset what was typed, and not while something else is sent", () => {
  const action = vi.fn();
  const onSent = vi.fn();
  const submit = (held: boolean) => {
    const form = nodes(InviteForm({ state: {}, shown: {}, action, held, inviting: false, onSent, signInAt: "app.usetrawler.test" })).find((n) => n.type === "form")!;
    const event = { preventDefault: vi.fn(), currentTarget: undefined };
    (form.props!.onSubmit as (e: unknown) => void)(event);
    return event.preventDefault;
  };
  expect(submit(true)).toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
  expect(submit(false)).toHaveBeenCalled();
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledWith(expect.any(FormData));
});

test("a successful invitation clears the address and sets the role back to Member; a refused one leaves both", () => {
  InviteForm({ state: { invited: "max@acme.test" }, shown: {}, action: () => {}, held: false, inviting: false, onSent: () => {}, signInAt: "app.usetrawler.test" });
  expect(react.set).toEqual(["", "member"]);
  react.set = [];
  InviteForm({ state: { error: "That address is already in this workspace." }, shown: {}, action: () => {}, held: false, inviting: false, onSent: () => {}, signInAt: "app.usetrawler.test" });
  expect(react.set).toEqual([]);
});

test("the role waits while an invitation is sent", () => {
  const select = (inviting: boolean) => nodes(InviteForm({ state: {}, shown: {}, action: () => {}, held: inviting, inviting, onSent: () => {}, signInAt: "app.usetrawler.test" })).find((n) => n.type === "select")!;
  (select(true).props!.onChange as (e: unknown) => void)({ target: { value: "admin" } });
  expect(react.set).toEqual([]);
  (select(false).props!.onChange as (e: unknown) => void)({ target: { value: "admin" } });
  expect(react.set).toEqual(["admin"]);
});
