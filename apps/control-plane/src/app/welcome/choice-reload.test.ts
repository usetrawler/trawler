import { expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ served: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (serve: unknown) => { react.served.push(serve); return [{}, () => {}, false]; },
  useEffect: () => {},
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, () => {}],
}));
const actions = vi.hoisted(() => ({ joinWorkspaceAction: vi.fn(), startOwnWorkspaceAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { joinWorkspace, startOwnWorkspace, WorkspaceChoice } = await import("./choice.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");

test("both choices go through the step that turns an update into a message, and the server's answer is shown as it came", async () => {
  WorkspaceChoice({ invitations: [] });
  expect(react.served).toEqual([joinWorkspace, startOwnWorkspace]);
  const form = new FormData();
  actions.joinWorkspaceAction.mockResolvedValue({ error: "no longer open" });
  expect(await joinWorkspace({}, form)).toEqual({ error: "no longer open" });
  expect(actions.joinWorkspaceAction).toHaveBeenCalledWith({}, form);
  actions.startOwnWorkspaceAction.mockResolvedValue({});
  expect(await startOwnWorkspace()).toEqual({});
  expect(actions.startOwnWorkspaceAction).toHaveBeenCalled();
});

test("a choice sent from a page left open across an update is told to reload; any other failure, such as a redirect, goes on as before", async () => {
  for (const [step, action] of [[() => joinWorkspace({}, new FormData()), actions.joinWorkspaceAction], [() => startOwnWorkspace(), actions.startOwnWorkspaceAction]] as const) {
    action.mockRejectedValue(new UnrecognizedActionError("Server action not found."));
    expect(await step()).toEqual({ error: "Trawler has been updated since this page opened. Reload the page and choose again." });
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/;307;" });
    action.mockRejectedValue(redirect);
    await expect(step()).rejects.toBe(redirect);
  }
});
