import { expect, test, vi } from "vitest";

vi.mock("./actions.ts", () => ({ inviteMemberAction: async () => ({}), revokeInvitationAction: async () => ({}), removeMemberAction: async () => ({}), changeRoleAction: async () => ({}) }));

const { afterAnswer, nextFlow, QUIET, said } = await import("./members.tsx");
const before = {};
const answers = (overrides: Record<string, object> = {}) => ({ change: before, remove: {}, revoke: {}, invite: {}, ...overrides });

test("what is sent is remembered with the answer it replaces", () => {
  expect(nextFlow(QUIET, { type: "sent", change: "change", before })).toEqual({ sent: { change: "change", before }, confirming: null, focus: null });
});

test("opening or keeping a confirmation drops a removal's answer, but not another change's", () => {
  const removal = { ...QUIET, sent: { change: "remove" as const, before } };
  const roleChange = { ...QUIET, sent: { change: "change" as const, before } };
  expect(nextFlow(removal, { type: "confirm", id: "m-2" })).toEqual({ sent: null, confirming: "m-2", focus: null });
  expect(nextFlow(roleChange, { type: "confirm", id: "m-2" })).toEqual({ sent: roleChange.sent, confirming: "m-2", focus: null });
  expect(nextFlow({ ...removal, confirming: "m-2" }, { type: "keep", id: "m-2" })).toEqual({ sent: null, confirming: null, focus: { remove: "m-2" } });
  expect(nextFlow({ ...roleChange, confirming: "m-2" }, { type: "keep", id: "m-2" })).toEqual({ sent: roleChange.sent, confirming: null, focus: { remove: "m-2" } });
});

test("an answered removal closes its confirmation, a refused one keeps it open, and focus goes to the heading only when the answer left it nowhere", () => {
  const open = { sent: { change: "remove" as const, before }, confirming: "m-2", focus: null };
  expect(nextFlow(open, { type: "answered", change: "remove", result: { done: "Lee is removed from this workspace." }, focusLost: true })).toEqual({ ...open, confirming: null, focus: "heading" });
  expect(nextFlow(open, { type: "answered", change: "remove", result: { error: "They could not be removed. Try again." }, focusLost: false })).toEqual(open);
  expect(nextFlow({ ...open, confirming: null }, { type: "answered", change: "change", result: { done: "Lee is now an admin." }, focusLost: false })).toEqual({ ...open, confirming: null });
  expect(nextFlow({ ...open, focus: "heading" }, { type: "focused" })).toEqual(open);
});

test("an answer counts only for the change that was sent, and only once it is a new result", () => {
  const flow = { ...QUIET, sent: { change: "remove" as const, before } };
  const result = { done: "Lee is removed from this workspace." };
  expect(afterAnswer(flow, "remove", result, true)).toEqual({ type: "answered", change: "remove", result, focusLost: true });
  expect(afterAnswer(flow, "remove", before, true)).toBeNull();
  expect(afterAnswer(flow, "change", result, true)).toBeNull();
  expect(afterAnswer(QUIET, "remove", result, true)).toBeNull();
});

test("nothing is said before the answer to what was sent arrives, or while anything is sent; then that answer is said, with its change", () => {
  const flow = { ...QUIET, sent: { change: "change" as const, before } };
  expect(said(QUIET, answers({ change: { done: "Lee is now an admin." } }), false)).toEqual({});
  expect(said(flow, answers(), false)).toEqual({});
  expect(said(flow, answers({ change: { done: "Lee is now an admin." } }), true)).toEqual({});
  expect(said(flow, answers({ change: { done: "Lee is now an admin." }, revoke: { done: "older" } }), false)).toEqual({ done: "Lee is now an admin.", change: "change" });
});
