import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell.tsx";

function docsLink(html: string): string {
  const link = html.match(/<a [^>]*href="https:\/\/usetrawler\.com\/docs\/"[^>]*>.*?<\/a>/)?.[0];
  if (!link) throw new Error("no link to the docs in the header");
  return link;
}

const render = (current?: "projects" | "new") => renderToStaticMarkup(createElement(AppShell, { organization: "acme-org", email: "ana@example.com", current, children: "page" }));
const link = (html: string, label: string) => html.match(new RegExp(`<a [^>]*>(?:(?!</a>).)*${label}(?:(?!</a>).)*</a>`))?.[0] ?? "";

describe("AppShell", () => {
  it("leads home from the brand, and to the projects and a new project from the header", () => {
    const html = render();
    expect(link(html, "trawler")).toContain('href="/"');
    expect(link(html, "Projects")).toContain('href="/"');
    expect(link(html, "New project")).toContain('href="/new"');
    expect(html).not.toContain("aria-current");
  });

  it("marks the page the person is on, with an underline as well as colour", () => {
    expect(link(render("projects"), "Projects")).toContain('aria-current="page"');
    expect(link(render("projects"), "New project")).not.toContain("aria-current");
    expect(link(render("new"), "New project")).toContain('aria-current="page"');
    expect(link(render("new"), "New project")).toMatch(/class="[^"]*\baria-\[current=page\]:underline\b/);
  });

  it("offers Sign out on every page", () => {
    expect(render()).toMatch(/<button type="button" class="[^"]*">Sign out<\/button>/);
  });

  it("links to the product docs in a new tab, and says so to a screen reader", () => {
    const link = docsLink(renderToStaticMarkup(createElement(AppShell, { organization: "acme-org", email: "ana@example.com", children: "page" })));
    expect(link).toMatch(/>Docs</);
    expect(link).toContain('target="_blank"');
    expect(link).toMatch(/rel="[^"]*\bnoreferrer\b[^"]*"/);
    expect(link).toContain('<span aria-hidden="true"> ↗</span>');
    expect(link).toMatch(/<span class="sr-only[^"]*"> \(opens in a new tab\)<\/span>/);
  });
});
