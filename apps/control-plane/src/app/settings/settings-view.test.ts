import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("./actions.ts", () => ({ renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}) }));

const { ModelKey, RemoveForm, removedStatus, ReplaceForm, savedStatus } = await import("./model-key.tsx");
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
  const html = render(createElement(ReplaceForm, { saved, onSaved: nothing, onKeep: nothing }));
  expect(html.match(/<input [^>]*name="apiKey"[^>]*>/)?.[0]).toMatch(/\bautofocus=""/);
  expect(html).toMatch(/<label for="([^"]+)"[^>]*>An API key from your model provider[^<]*<\/label><div class="flex gap-2"><input id="\1" [^>]*name="apiKey"[^>]*\/?><button type="button"[^>]*>Keep …a1b2<\/button><\/div>/);
  expect(html).toMatch(/<button type="submit"[^>]*>Save key<\/button><span[^>]*>Saved once the provider accepts it\.<\/span>/);
});

test("the remove step names what it stops, on the button that confirms it", () => {
  const html = render(createElement(RemoveForm, { onRemoved: nothing, onKeep: nothing }));
  expect(html).toContain('<p id="remove-warning">Remove the key? The workspace&#x27;s runs that are going now stop, and Start asks for a new key.</p>');
  expect(html).toMatch(/<button type="submit" aria-describedby="remove-warning"[^>]*>Remove the key<\/button><button type="button"[^>]*>Keep the key<\/button>/);
});

test("a saved or removed key is reported, with any runs it stopped, and a key no models could be listed for says when it is checked", () => {
  expect(savedStatus({ saved: true, unchecked: false })).toBe("Key saved.");
  expect(savedStatus({ saved: true, unchecked: true })).toBe("Key saved. That service lists no models, so the key is checked when a run starts.");
  expect(removedStatus({ saved: true, stoppedRuns: 0 })).toBe("Key removed.");
  expect(removedStatus({ saved: true, stoppedRuns: 1 })).toBe("Key removed. The run that was going is stopped.");
  expect(removedStatus({ saved: true, stoppedRuns: 3 })).toBe("Key removed. The 3 runs that were going are stopped.");
});

test("the key's status line is always there for screen readers, and takes no room while empty", () => {
  expect(render(createElement(ModelKey, { saved, addedBy: null, canManage: true }))).toMatch(/<p role="status" class="text-sm text-ok empty:-mt-4"><\/p><\/section>$/);
});

test("an owner or admin edits the workspace name; a member reads it as text, with nothing to submit", () => {
  const owner = render(createElement(WorkspaceName, { name: "Acme", canManage: true }));
  expect(owner.match(/<input[^>]*\bname="name"[^>]*>/)?.[0]).toContain('value="Acme"');
  expect(owner).toMatch(/<button type="submit"[^>]*>Save name<\/button>/);
  const member = render(createElement(WorkspaceName, { name: "Acme", canManage: false }));
  expect(member).not.toMatch(/<form|<input|<button/);
  expect(member).toMatch(/<p class="text-lg font-bold wrap-anywhere">Acme<\/p><p class="text-sm text-muted">Only an owner or admin of this workspace can rename it\.<\/p>/);
});
