import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Shell } from "../server/shell.ts";
import { AppShell, type ShellPage } from "./app-shell.tsx";
import { initials } from "./initials.ts";

const shell: Shell = {
  user: { name: "Ben Ortiz", email: "ben@acme.test" },
  workspace: { name: "Acme Labs", projects: [{ id: "p1", name: "Acme Invoices", address: "app.acme.test" }, { id: "p2", name: "Globex Store", address: "shop.globex.test" }], runs: 17 },
};

const render = (options: { current?: ShellPage; parent?: boolean; shell?: Shell } = {}) =>
  renderToStaticMarkup(createElement(AppShell, { shell: options.shell ?? shell, current: options.current, parent: options.parent, children: "page" }));
const link = (html: string, label: string) => html.match(new RegExp(`<a [^>]*>(?:(?!</a>).)*${label}(?:(?!</a>).)*</a>`))?.[0] ?? "";
const nav = (html: string) => html.match(/<nav aria-label="Workspace".*?<\/nav>/)?.[0] ?? "";
const menus = (html: string) => html.match(/<details class="[^"]*">.*?<\/details>/g) ?? [];
const marked = (html: string) => nav(html).match(/<a [^>]*aria-current="[^"]*"[^>]*>(?:(?!<\/a>).)*<\/a>/g) ?? [];

describe("AppShell", () => {
  it("leads home from the brand, and to the overview, findings, all runs, each project, a new project and the settings from the nav", () => {
    const html = render();
    expect(link(html, "trawler")).toContain('href="/"');
    const items = [...nav(html).matchAll(/<a href="([^"]*)"[^>]*>(?:(?!<\/a>).)*?<span class="min-w-0" title="[^"]*"><span class="block truncate">([^<]*)/g)].map((m) => [m[1], m[2]]);
    expect(items).toEqual([["/", "Overview"], ["/findings", "Findings"], ["/runs", "All runs"], ["/projects/p1/overview", "Acme Invoices"], ["/projects/p2/overview", "Globex Store"], ["/new", "New project"], ["/settings", "Settings"]]);
    expect(nav(html)).not.toContain("aria-current");
  });

  it("counts the workspace's runs next to All runs", () => {
    expect(link(nav(render()), "All runs")).toMatch(/>17<\/span><\/a>$/);
  });

  it("groups the projects under a Projects heading with their number, each with its product's address under its name", () => {
    const html = nav(render());
    expect(html).toMatch(/<p id="nav-projects" class="[^"]*">Projects · 2<\/p><ul aria-labelledby="nav-projects"[^>]*><li[^>]*><a href="\/projects\/p1\/overview"/);
    expect(html).toContain('title="Acme Invoices · app.acme.test"><span class="block truncate">Acme Invoices</span><span class="block truncate text-xs font-normal text-muted">app.acme.test</span></span>');
    expect(html).toMatch(/<ul aria-labelledby="nav-projects".*href="\/new".*<\/ul>/);
    expect(html).not.toMatch(/<ul aria-labelledby="nav-projects".*href="\/runs".*<\/ul>/);
    expect(html).not.toMatch(/<ul aria-labelledby="nav-projects"(?:(?!<\/ul>).)*href="\/settings"/);
  });

  it("marks only the page the person is on, with a raised surface and weight as well as colour", () => {
    const only = (options: { current: ShellPage; parent?: boolean }) => marked(render(options));
    expect(only({ current: "overview" })).toEqual([expect.stringContaining('href="/"')]);
    expect(only({ current: "runs" })).toEqual([expect.stringContaining('href="/runs"')]);
    expect(only({ current: { project: "p2" } })).toEqual([expect.stringContaining('href="/projects/p2/overview"')]);
    expect(only({ current: "new" })).toEqual([expect.stringContaining('href="/new"')]);
    expect(only({ current: "settings" })).toEqual([expect.stringContaining('href="/settings"')]);
    expect(only({ current: { project: "gone" } })).toEqual([]);
    expect(only({ current: "runs" })[0]).toContain('aria-current="page"');
    expect(only({ current: "runs" })[0]).toMatch(/class="[^"]*\bbg-panel\b[^"]*\bfont-medium\b/);
    expect(link(nav(render({ current: "runs" })), "Overview")).not.toContain("font-medium");
  });

  it("marks the section a page belongs to as current without calling it the page itself", () => {
    const [runs] = marked(render({ current: "runs", parent: true }));
    expect(runs).toContain('href="/runs"');
    expect(runs).toContain('aria-current="true"');
  });

  it("names the workspace under the brand", () => {
    expect(link(render(), "trawler")).toMatch(/>trawler<\/span><span class="[^"]*" title="Acme Labs">Acme Labs<\/span>/);
  });

  it("has no header bar: the account menu holds who is signed in, the docs, the theme and Sign out", () => {
    const html = render();
    expect(html).not.toContain("<header");
    const [phone, desktop] = menus(html);
    expect(phone).toMatch(/^<details class="[^"]*\bmd:hidden\b/);
    expect(desktop).toMatch(/^<details class="[^"]*\bhidden\b[^"]*\bmd:block\b/);
    for (const menu of [phone!, desktop!]) {
      expect(menu).toContain('aria-label="Account: Ben Ortiz"');
      expect(menu).toMatch(/>BO<\/span>/);
      expect(menu).toMatch(/>Signed in as Ben Ortiz<\/p><p [^>]*>ben@acme\.test<\/p>/);
      expect(menu).toMatch(/href="https:\/\/usetrawler\.com\/docs\/"/);
      expect(menu).toMatch(/<button type="button" title="Theme: System\. Switch to Dark\."/);
      expect(menu).toMatch(/>Sign out<\/button><\/div><\/details>$/);
    }
  });

  it("shows an account without a name by its email, once", () => {
    const [menu] = menus(render({ shell: { ...shell, user: { name: "", email: "lee@acme.test" } } }));
    expect(menu).toMatch(/>LE<\/span>/);
    expect(menu).toContain(">Signed in as lee@acme.test</p>");
    expect(menu!.match(/<p [^>]*>lee@acme\.test<\/p>/g)).toBeNull();
  });

  it("shows the address the data gives, so projects that share a name stay apart", () => {
    const twins: Shell = { ...shell, workspace: { ...shell.workspace, projects: [{ id: "a", name: "Shop", address: "staging.shop.test" }, { id: "b", name: "Shop", address: "pr-9.shop.test/checkout" }] } };
    const html = nav(render({ shell: twins }));
    expect(html).toContain('title="Shop · staging.shop.test"><span class="block truncate">Shop</span><span class="block truncate text-xs font-normal text-muted">staging.shop.test</span></span>');
    expect(html).toContain('title="Shop · pr-9.shop.test/checkout"><span class="block truncate">Shop</span><span class="block truncate text-xs font-normal text-muted">pr-9.shop.test/checkout</span></span>');
  });

  it("puts the whole nav in one sideways row on a phone, without the Projects heading", () => {
    const html = render();
    expect(html).toMatch(/<nav aria-label="Workspace" class="flex [^"]*\boverflow-x-auto\b[^"]*\bmd:block\b/);
    expect(html).toMatch(/<p id="nav-projects" class="hidden [^"]*\bmd:block\b/);
  });

  it("keeps the panel in view on a wide screen and lets its nav scroll on its own", () => {
    const html = render();
    expect(html).toMatch(/<div class="[^"]*\bmd:sticky\b[^"]*\bmd:top-0\b[^"]*\bmd:h-dvh\b/);
    expect(html).toMatch(/<nav aria-label="Workspace" class="[^"]*\bmd:overflow-y-auto\b/);
  });

  it("hides the wordmark below 360 px, for screen readers only", () => {
    expect(link(render(), "trawler")).toMatch(/<span class="[^"]*\bmax-\[360px\]:sr-only\b[^"]*">trawler<\/span>/);
  });

  it("lets a keyboard skip the panel", () => {
    const html = render();
    expect(html).toMatch(/^<div[^>]*><a href="#main" class="sr-only[^"]*focus:not-sr-only[^"]*\bfocus:px-4 focus:py-3">Skip to content<\/a>/);
    expect(html).toMatch(/<main id="main" class=/);
    expect(html).not.toContain("tabindex");
  });

  it("links to the product docs in a new tab, and says so to a screen reader", () => {
    const docs = render().match(/<a [^>]*href="https:\/\/usetrawler\.com\/docs\/"[^>]*>.*?<\/a>/)?.[0] ?? "";
    expect(docs).toMatch(/>Docs</);
    expect(docs).toContain('target="_blank"');
    expect(docs).toMatch(/rel="[^"]*\bnoreferrer\b[^"]*"/);
    expect(docs).toContain('<span aria-hidden="true"> ↗</span>');
    expect(docs).toMatch(/<span class="sr-only[^"]*"> \(opens in a new tab\)<\/span>/);
  });
});

describe("initials", () => {
  it("takes the first letters of two words, or the first two letters of one", () => {
    expect(initials("Acme Labs")).toBe("AL");
    expect(initials("umbrella")).toBe("UM");
    expect(initials("ana.lopez@acme.test")).toBe("AL");
    expect(initials("lee@acme.test")).toBe("LE");
    expect(initials("  ")).toBe("?");
  });

  it("keeps a letter outside the basic plane whole", () => {
    expect(initials("🚀 Rocket Launch")).toBe("🚀R");
    expect(initials("Ana 😀")).toBe("A😀");
    expect(initials("𝒜cme")).toBe("𝒜C");
  });
});

test("a project with a run going carries a dot, told to screen readers, and the others carry none", () => {
  const html = render({ shell: { ...shell, workspace: { ...shell.workspace, projects: shell.workspace.projects.map((p, i) => (i === 0 ? { ...p, live: true } : p)) } } });
  const first = link(nav(html), shell.workspace.projects[0]!.name);
  expect(first).toMatch(/<span aria-hidden="true" class="size-2 rounded-full bg-ok"><\/span><span class="sr-only">, a run is going<\/span>/);
  expect(link(nav(html), shell.workspace.projects[1]!.name)).not.toContain("a run is going");
});
