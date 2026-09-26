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
const header = (html: string) => html.match(/<header.*<\/header>/)?.[0] ?? "";
const account = (html: string) => html.match(/<\/nav><section aria-label="Account" class="[^"]*">.*?<\/section>/)?.[0] ?? "";
const marked = (html: string) => nav(html).match(/<a [^>]*aria-current="[^"]*"[^>]*>(?:(?!<\/a>).)*<\/a>/g) ?? [];

describe("AppShell", () => {
  it("leads home from the brand, and to the overview, all runs, each project, a new project and the settings from the nav", () => {
    const html = render();
    expect(link(html, "trawler")).toContain('href="/"');
    const items = [...nav(html).matchAll(/<a href="([^"]*)"[^>]*>(?:(?!<\/a>).)*?<span class="min-w-0" title="[^"]*"><span class="block truncate">([^<]*)/g)].map((m) => [m[1], m[2]]);
    expect(items).toEqual([["/", "Overview"], ["/runs", "All runs"], ["/projects/p1", "Acme Invoices"], ["/projects/p2", "Globex Store"], ["/new", "New project"], ["/settings", "Settings"]]);
    expect(html).not.toContain("aria-current");
  });

  it("counts the workspace's runs next to All runs", () => {
    expect(link(nav(render()), "All runs")).toMatch(/>17<\/span><\/a>$/);
  });

  it("groups the projects under a Projects heading, each with its product's address under its name", () => {
    const html = nav(render());
    expect(html).toMatch(/<p id="nav-projects" class="[^"]*">Projects<\/p><ul aria-labelledby="nav-projects"[^>]*><li[^>]*><a href="\/projects\/p1"/);
    expect(html).toContain('title="Acme Invoices · app.acme.test"><span class="block truncate">Acme Invoices</span><span class="block truncate text-[10px] text-muted">app.acme.test</span></span>');
    expect(html).toMatch(/<ul aria-labelledby="nav-projects".*href="\/new".*<\/ul>/);
    expect(html).not.toMatch(/<ul aria-labelledby="nav-projects".*href="\/runs".*<\/ul>/);
    expect(html).not.toMatch(/<ul aria-labelledby="nav-projects"(?:(?!<\/ul>).)*href="\/settings"/);
  });

  it("marks only the page the person is on, with a bar on its edge as well as colour", () => {
    const only = (options: { current: ShellPage; parent?: boolean }) => marked(render(options));
    expect(only({ current: "overview" })).toEqual([expect.stringContaining('href="/"')]);
    expect(only({ current: "runs" })).toEqual([expect.stringContaining('href="/runs"')]);
    expect(only({ current: { project: "p2" } })).toEqual([expect.stringContaining('href="/projects/p2"')]);
    expect(only({ current: "new" })).toEqual([expect.stringContaining('href="/new"')]);
    expect(only({ current: "settings" })).toEqual([expect.stringContaining('href="/settings"')]);
    expect(only({ current: { project: "gone" } })).toEqual([]);
    expect(only({ current: "runs" })[0]).toContain('aria-current="page"');
    expect(only({ current: "runs" })[0]).toMatch(/class="[^"]*\bshadow-\[inset_2px_0_var\(--action\)\]/);
    expect(link(nav(render({ current: "runs" })), "Overview")).not.toContain("shadow-[inset");
  });

  it("marks the section a page belongs to as current without calling it the page itself", () => {
    const [runs] = marked(render({ current: "runs", parent: true }));
    expect(runs).toContain('href="/runs"');
    expect(runs).toContain('aria-current="true"');
    expect(runs).toMatch(/\bshadow-\[inset_2px_0_var\(--action\)\]/);
  });

  it("names the workspace with its initials and its number of projects", () => {
    const html = render();
    expect(html).toMatch(/>AL<\/span><div class="min-w-0"><p class="[^"]*" title="Acme Labs">Acme Labs<\/p><p class="[^"]*">2 projects<\/p>/);
    expect(render({ shell: { ...shell, workspace: { ...shell.workspace, projects: [{ id: "p1", name: "Acme", address: "app.acme.test" }] } } })).toContain(">1 project</p>");
  });

  it("shows who is signed in at the bottom of the panel, by name and email, with Sign out", () => {
    const block = account(render());
    expect(block).toMatch(/^<\/nav><section aria-label="Account" class="[^"]*\bhidden\b[^"]*\bmd:block\b/);
    expect(block).toMatch(/>BO<\/span>.*>Ben Ortiz<\/p><p [^>]*>ben@acme\.test<\/p>.*>Sign out<\/button><\/section>$/);
  });

  it("shows an account without a name by its email, once, and says so on a phone", () => {
    const html = render({ shell: { ...shell, user: { name: "", email: "lee@acme.test" } } });
    expect(header(html)).toContain('<span class="sr-only md:hidden">Signed in as lee@acme.test</span>');
    expect(header(html)).toMatch(/>LE<\/span>/);
    const block = account(html);
    expect(block).toMatch(/>LE<\/span><div class="min-w-0"><p class="truncate text-sm font-bold" title="lee@acme\.test">lee@acme\.test<\/p><\/div>/);
    expect(block.match(/lee@acme\.test<\/p>/g)).toHaveLength(1);
  });

  it("keeps who is signed in and Sign out in the header on a phone, where the panel has no room", () => {
    const top = header(render());
    expect(top).toContain('<span class="sr-only md:hidden">Signed in as Ben Ortiz</span>');
    expect(top).toMatch(/<span aria-hidden="true" class="[^"]*\bmd:hidden\b[^"]*">BO<\/span>/);
    expect(top).toMatch(/<button type="button" class="[^"]*\bmd:hidden\b[^"]*">Sign out<\/button>/);
  });

  it("shows the address the data gives, so projects that share a name stay apart", () => {
    const twins: Shell = { ...shell, workspace: { ...shell.workspace, projects: [{ id: "a", name: "Shop", address: "staging.shop.test" }, { id: "b", name: "Shop", address: "pr-9.shop.test/checkout" }] } };
    const html = nav(render({ shell: twins }));
    expect(html).toContain('title="Shop · staging.shop.test"><span class="block truncate">Shop</span><span class="block truncate text-[10px] text-muted">staging.shop.test</span></span>');
    expect(html).toContain('title="Shop · pr-9.shop.test/checkout"><span class="block truncate">Shop</span><span class="block truncate text-[10px] text-muted">pr-9.shop.test/checkout</span></span>');
  });

  it("puts the whole nav in one sideways row on a phone, without the Projects heading", () => {
    const html = render();
    expect(html).toMatch(/<nav aria-label="Workspace" class="flex [^"]*\boverflow-x-auto\b[^"]*\bmd:block\b/);
    expect(html).toMatch(/<p id="nav-projects" class="hidden [^"]*\bmd:block\b/);
  });

  it("keeps the header and the panel in view only where the screen is tall enough for the whole panel", () => {
    const html = render();
    expect(html).toMatch(/<header class="[^"]*\btall:sticky\b[^"]*\btall:top-0\b/);
    expect(html).toMatch(/<div class="[^"]*\btall:sticky\b[^"]*\btall:top-\[76px\][^"]*\btall:h-\[calc\(100dvh-76px\)\]/);
    expect(html).toMatch(/<nav aria-label="Workspace" class="[^"]*\btall:overflow-y-auto\b/);
    expect(html).not.toMatch(/\bmd:sticky\b/);
  });

  it("makes room on a phone's header by hiding the initials below 400 px and the wordmark, for screen readers only, below 360 px", () => {
    const top = header(render());
    expect(top).toMatch(/<span class="max-\[360px\]:sr-only">trawler<\/span><\/a>/);
    expect(top).toMatch(/<span aria-hidden="true" class="[^"]*\bmax-\[400px\]:hidden\b[^"]*">BO<\/span>/);
  });

  it("offers the theme switch at the end of the header", () => {
    expect(header(render())).toMatch(/<button type="button" title="Theme: System\. Switch to Dark\."[^>]*>(?:(?!<\/button>).)*<\/button><\/div><\/header>$/);
  });

  it("lets a keyboard skip the header and the panel", () => {
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
