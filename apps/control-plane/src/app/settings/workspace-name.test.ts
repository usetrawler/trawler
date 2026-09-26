import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ result: {} as Record<string, unknown>, pending: false, states: [] as unknown[], served: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (serve: unknown) => { react.served.push(serve); return [react.result, () => {}, react.pending]; },
  useState: (initial: unknown) => [react.states.length ? react.states.shift() : initial, () => {}],
  useEffect: () => {},
}));
const actions = vi.hoisted(() => ({ renameWorkspaceAction: vi.fn(), replaceModelKeyAction: vi.fn(), removeModelKeyAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { renameWorkspace, WorkspaceName } = await import("./workspace-name.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");
const RULE = "Workspace names are 1 to 100 plain characters.";
const render = () => renderToStaticMarkup(createElement(WorkspaceName, { name: "Acme", canManage: true }));
const saved = (html: string) => html.match(/<span role="status"[^>]*>([^<]*)<\/span>/)?.[1];

beforeEach(() => {
  react.result = {};
  react.pending = false;
  react.states = [];
  react.served = [];
  actions.renameWorkspaceAction.mockReset();
});

test("Saved. shows after a rename, and goes once the name is edited again", () => {
  react.result = { saved: true };
  expect(saved(render())).toBe("Saved.");
  react.states = ["Acme Labs edited", true];
  expect(saved(render())).toBe("");
});

test("a refused name is shown with its field marked, and hidden while the next save runs so a repeat is announced again", () => {
  react.result = { error: RULE };
  const refused = render();
  expect(refused).toContain(`<p id="workspace-error" role="alert" class="border-l-2 border-bad pl-3 text-sm text-bad">${RULE}</p>`);
  expect(refused.match(/<input [^>]*name="name"[^>]*>/)?.[0]).toMatch(/aria-invalid="true" aria-describedby="workspace-error"/);
  react.pending = true;
  const saving = render();
  expect(saving).not.toContain('role="alert"');
  expect(saving.match(/<input [^>]*name="name"[^>]*>/)?.[0]).not.toContain("aria-invalid");
});

const named = () => {
  const data = new FormData();
  data.set("name", "Acme Labs");
  return data;
};

test("a rename goes through the step that turns an update into a message, and the server's answer is shown as it came", async () => {
  render();
  expect(react.served).toEqual([renameWorkspace]);
  actions.renameWorkspaceAction.mockResolvedValue({ error: RULE });
  expect(await renameWorkspace({}, named())).toEqual({ error: RULE });
});

test("a rename from a page left open across an update is told to reload; any other failure goes on as before", async () => {
  actions.renameWorkspaceAction.mockRejectedValue(new UnrecognizedActionError("Server action not found."));
  expect(await renameWorkspace({}, named())).toEqual({ error: "Trawler was updated since this page opened. Reload the page to rename the workspace." });
  const failure = new TypeError("Failed to fetch");
  actions.renameWorkspaceAction.mockRejectedValue(failure);
  await expect(renameWorkspace({}, named())).rejects.toBe(failure);
});
