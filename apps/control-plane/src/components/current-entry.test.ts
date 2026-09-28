import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Shell } from "../server/shell.ts";
import { AppShell } from "./app-shell.tsx";
import { CURRENT_ENTRY_SCRIPT, revealCurrentEntry } from "./current-entry.ts";

type Row = { scrollLeft: number; querySelector: (selector: string) => unknown; getBoundingClientRect: () => { left: number; right: number } };

const row = (width: number, entry: { left: number; width: number } | null): Row => {
  const nav: Row = {
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, right: width }),
    querySelector: (selector) => (selector === "[aria-current]" && entry ? { getBoundingClientRect: () => ({ left: entry.left - nav.scrollLeft, right: entry.left + entry.width - nav.scrollLeft }) } : null),
  };
  return nav;
};
const reveal = (nav: Row | null) => revealCurrentEntry(nav as unknown as Element | null);

test("an entry past the right edge of a phone's row is scrolled into view, just inside the edge", () => {
  const nav = row(390, { left: 1031, width: 104 });
  reveal(nav);
  expect(nav.scrollLeft).toBe(1031 + 104 - 390 + 8);
});

test("an entry left of the row's view, after the row was scrolled, is brought back just inside the left edge", () => {
  const nav = row(320, { left: 40, width: 90 });
  nav.scrollLeft = 200;
  reveal(nav);
  expect(nav.scrollLeft).toBe(32);
});

test("an entry already in view, or no current entry, leaves the row where it is", () => {
  const inView = row(390, { left: 120, width: 100 });
  reveal(inView);
  expect(inView.scrollLeft).toBe(0);
  const none = row(390, null);
  reveal(none);
  expect(none.scrollLeft).toBe(0);
  expect(() => reveal(null)).not.toThrow();
});

test("an entry wider than the row shows its start, where the icon and name begin", () => {
  const nav = row(320, { left: 900, width: 400 });
  reveal(nav);
  expect(nav.scrollLeft).toBe(900 - 8);
});

test("the inline script reveals the entry of the nav right before it, as the page is read and before it is drawn", () => {
  const nav = row(390, { left: 1031, width: 104 });
  new Function("document", CURRENT_ENTRY_SCRIPT)({ currentScript: { previousElementSibling: nav } });
  expect(nav.scrollLeft).toBe(1031 + 104 - 390 + 8);
  expect(() => new Function("document", CURRENT_ENTRY_SCRIPT)({ currentScript: null })).not.toThrow();
});

test("the shell puts the script right after the workspace nav", () => {
  const shell: Shell = { user: { name: "Ben", email: "ben@acme.test" }, workspace: { name: "Acme", projects: [], runs: 0 } };
  const html = renderToStaticMarkup(createElement(AppShell, { shell, current: "settings", children: "page" }));
  expect(html).toContain(`</ul></nav><script type="text/javascript">${CURRENT_ENTRY_SCRIPT}</script><section aria-label="Account"`);
});
