import { expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ served: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (serve: unknown) => { react.served.push(serve); return [{}, () => {}, false]; },
  useReducer: (_reducer: unknown, initial: unknown) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, () => {}],
}));
const actions = vi.hoisted(() => ({ changeRoleAction: vi.fn(), removeMemberAction: vi.fn(), revokeInvitationAction: vi.fn(), inviteMemberAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { changeRole, inviteSomeone, Members, removeSomeone, revokeInvitation } = await import("./members.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");
const through = [
  [changeRole, actions.changeRoleAction, "Reload the page to change their role."],
  [removeSomeone, actions.removeMemberAction, "Reload the page to remove them."],
  [revokeInvitation, actions.revokeInvitationAction, "Reload the page to revoke the invitation."],
  [inviteSomeone, actions.inviteMemberAction, "Reload the page to invite them."],
] as const;

test("every members change goes through the step that turns an update into a message, and the server's answer is shown as it came", async () => {
  Members({ members: [], invitations: [], canManage: true, signInAt: "app.usetrawler.test" });
  expect(react.served).toEqual(through.map(([step]) => step));
  for (const [step, action] of through) {
    const previous = { done: "earlier" };
    const form = new FormData();
    action.mockResolvedValue({ done: "now" });
    expect(await step(previous, form)).toEqual({ done: "now" });
    expect(action).toHaveBeenCalledWith(previous, form);
  }
});

test("a members change sent from a page left open across an update is told to reload; any other failure goes on as before", async () => {
  for (const [step, action, then] of through) {
    action.mockRejectedValue(new UnrecognizedActionError("Server action not found."));
    expect(await step({}, new FormData())).toEqual({ error: `Trawler has been updated since this page opened. ${then}` });
    const failure = new TypeError("Failed to fetch");
    action.mockRejectedValue(failure);
    await expect(step({}, new FormData())).rejects.toBe(failure);
  }
});
