import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("./actions.ts", () => ({ renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}) }));

const { afterRemove, afterReplace, ModelKey, nextPanel, RemoveForm, removedStatus, ReplaceForm, savedStatus } = await import("./model-key.tsx");
const { WorkspaceName } = await import("./workspace-name.tsx");
const saved = { provider: "openrouter" as const, hint: "…a1b2", baseUrl: null, addedAt: "2026-09-25T18:50:00.000Z" };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const nothing = () => {};

test("the key shows its provider, last characters, who added it and when, with Replace and Remove", () => {
  const html = render(createElement(ModelKey, { saved, addedBy: "ana@acme.test", canManage: true }));
  expect(text(html)).toContain("OpenRouter key …a1b2");
  expect(text(html)).toContain("Added by ana@acme.test on 2026-09-25 18:50 UTC");
  expect(html).toMatch(/<button type="button"[^>]*>Replace<\/button><button type="button"[^>]*>Remove<\/button>/);
  expect(html).not.toContain('name="apiKey"');
});

test("a key added by someone who has left says so, and an OpenAI-compatible key shows its base URL", () => {
  const html = text(render(createElement(ModelKey, { saved: { ...saved, provider: "custom", baseUrl: "https://llm.example.com/v1" }, addedBy: null, canManage: true })));
  expect(html).toContain("Added by someone no longer in this workspace on");
  expect(html).toContain("OpenAI-compatible key …a1b2");
  expect(html).toContain("Base URL https://llm.example.com/v1");
});

test("an owner or admin without a key is asked for one here, without the page jumping to it", () => {
  const html = render(createElement(ModelKey, { saved: null, addedBy: null, canManage: true }));
  expect(text(html)).toContain("No model key yet. Runs are paid with it: add one here, or in the Start panel of a plan.");
  expect(html).toMatch(/<input [^>]*name="apiKey"/);
  expect(html.match(/<input [^>]*name="apiKey"[^>]*>/)?.[0]).not.toContain("autofocus");
  expect(html).toMatch(/<button type="submit"[^>]*>Save key<\/button>/);
  expect(html).not.toContain(">Keep");
});

test("a member reads the key but cannot change it, and without a key is told who adds one", () => {
  const html = render(createElement(ModelKey, { saved, addedBy: "ana@acme.test", canManage: false }));
  expect(text(html)).toContain("OpenRouter key …a1b2");
  expect(text(html)).toContain("Only an owner or admin of this workspace can change the key.");
  expect(html).not.toMatch(/<button|<form|name="apiKey"/);
  const none = text(render(createElement(ModelKey, { saved: null, addedBy: null, canManage: false })));
  expect(none).toContain("No model key yet. Runs are paid with it, and an owner or admin of this workspace adds it.");
  expect(none).not.toMatch(/Start panel|Save key|Only an owner/);
});

test("replacing a key starts in its field, with Keep beside it and outside its label", () => {
  const html = render(createElement(ReplaceForm, { saved, action: nothing, pending: false, error: "", onKeep: nothing }));
  expect(html.match(/<input [^>]*name="apiKey"[^>]*>/)?.[0]).toMatch(/\bautofocus=""/);
  expect(html.match(/<input [^>]*name="apiKey"[^>]*>/)?.[0]).not.toContain("aria-invalid");
  expect(html).toMatch(/<label for="([^"]+)"[^>]*>An API key from your model provider[^<]*<\/label><div class="flex gap-2"><input id="\1" [^>]*name="apiKey"[^>]*\/?><button type="button"[^>]*>Keep …a1b2<\/button><\/div>/);
  expect(html).toMatch(/<button type="submit"[^>]*>Save key<\/button><span[^>]*>Saved once the provider accepts it\.<\/span>/);
});

test("the remove step names what it stops on both its buttons, and removes only the key the page shows", () => {
  const html = render(createElement(RemoveForm, { addedAt: saved.addedAt, action: nothing, pending: false, error: "", onKeep: nothing }));
  expect(html).toContain('<input type="hidden" name="addedAt" value="2026-09-25T18:50:00.000Z"/>');
  expect(html).toContain('<p id="remove-warning">Remove the key? The workspace&#x27;s runs that are going now stop, and Start asks for a new key.</p>');
  expect(html).toMatch(/<button type="submit" aria-describedby="remove-warning"[^>]*>Remove the key<\/button><button type="button" aria-describedby="remove-warning"[^>]*>Keep the key<\/button>/);
});

test("while a removal or a key check runs, Keep cannot leave the step and the last error is hidden, so the next one is announced afresh", () => {
  const removing = render(createElement(RemoveForm, { addedAt: saved.addedAt, action: nothing, pending: true, error: "E", onKeep: nothing }));
  expect(removing).toMatch(/<button type="submit" aria-describedby="remove-warning" aria-disabled="true"[^>]*>Removing…<\/button><button type="button" aria-describedby="remove-warning" aria-disabled="true"[^>]*>Keep the key<\/button>/);
  expect(removing).not.toContain('role="alert"');
  const checking = render(createElement(ReplaceForm, { saved, action: nothing, pending: true, error: "E", onKeep: nothing }));
  expect(checking).toMatch(/<button type="button" aria-disabled="true"[^>]*>Keep …a1b2<\/button>/);
  expect(checking).toMatch(/<button type="submit" aria-disabled="true"[^>]*>Checking the key…<\/button>/);
  expect(checking).not.toContain('role="alert"');
});

test("a refused key points its field at the reason", () => {
  const html = render(createElement(ReplaceForm, { saved, action: nothing, pending: false, error: "OpenRouter refused this key.", onKeep: nothing }));
  expect(html.match(/<input [^>]*name="apiKey"[^>]*>/)?.[0]).toMatch(/aria-invalid="true" aria-describedby="key-error"/);
  expect(html).toContain('<p id="key-error" role="alert" class="border-l-2 border-bad pl-3 text-sm text-bad">OpenRouter refused this key.</p>');
});

test("a saved or removed key is reported, with any runs it stopped, and a key no models could be listed for says when it is checked", () => {
  expect(savedStatus({ saved: true, unchecked: false })).toBe("Key saved.");
  expect(savedStatus({ saved: true, unchecked: true })).toBe("Key saved. That service lists no models, so the key is checked when a run starts.");
  expect(removedStatus({ saved: true, stoppedRuns: 0 })).toBe("Key removed.");
  expect(removedStatus({ saved: true, stoppedRuns: 1 })).toBe("Key removed. The run that was going is stopped.");
  expect(removedStatus({ saved: true, stoppedRuns: 3 })).toBe("Key removed. The 3 runs that were going are stopped.");
});

test("the key's status line sits under its heading, is always there for screen readers, and takes no room while empty", () => {
  expect(render(createElement(ModelKey, { saved, addedBy: null, canManage: true }))).toMatch(/^<section aria-labelledby="key-heading" [^>]*><h2 id="key-heading" tabindex="-1" class="font-mono text-xs tracking-\[0\.2em\] text-muted uppercase">Model key<\/h2><p role="status" class="text-sm text-ok empty:-mt-4"><\/p>/);
});

test("an owner or admin edits the workspace name; a member reads it as text, with nothing to submit", () => {
  const owner = render(createElement(WorkspaceName, { name: "Acme", canManage: true }));
  expect(owner.match(/<input[^>]*\bname="name"[^>]*>/)?.[0]).toContain('value="Acme"');
  expect(owner).toMatch(/<button type="submit"[^>]*>Save name<\/button>/);
  const member = render(createElement(WorkspaceName, { name: "Acme", canManage: false }));
  expect(member).not.toMatch(/<form|<input|<button/);
  expect(member).toMatch(/<p class="text-lg font-bold wrap-anywhere">Acme<\/p><p class="text-sm text-muted">Only an owner or admin of this workspace can rename it\.<\/p>/);
});

test("starting a step clears what the last one said, so an old error never comes back", () => {
  const refused = { step: "replacing" as const, status: "", error: "OpenRouter refused this key.", focus: null };
  expect(nextPanel(refused, { type: "back", to: "replace" })).toEqual({ step: "view", status: "", error: "", focus: "replace" });
  expect(nextPanel({ ...refused, step: "view", status: "Key saved." }, { type: "go", step: "replacing" })).toEqual({ step: "replacing", status: "", error: "", focus: null });
  expect(nextPanel({ ...refused, step: "confirming" }, { type: "go", step: "confirming" })).toMatchObject({ error: "" });
  expect(nextPanel({ step: "replacing", status: "", error: "", focus: null }, { type: "refused", error: "E" })).toEqual({ step: "replacing", status: "", error: "E", focus: null });
  expect(nextPanel({ step: "view", status: "Key saved.", error: "", focus: "replace" }, { type: "focused" })).toEqual({ step: "view", status: "Key saved.", error: "", focus: null });
});

test("a saved key returns to Replace and says so; a removal lands on the section heading with the runs it stopped; a refusal stays on its step", () => {
  expect(afterReplace({ saved: true, unchecked: false })).toEqual({ type: "back", to: "replace", status: "Key saved." });
  expect(afterReplace({ error: "E" })).toEqual({ type: "refused", error: "E" });
  expect(afterReplace({})).toBeNull();
  expect(afterRemove({ saved: true, stoppedRuns: 1 })).toEqual({ type: "back", to: "heading", status: "Key removed. The run that was going is stopped." });
  expect(afterRemove({ error: "E" })).toEqual({ type: "refused", error: "E" });
  expect(afterRemove({})).toBeNull();
});
