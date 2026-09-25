import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell.tsx";

function docsLink(html: string): string {
  const link = html.match(/<a [^>]*href="https:\/\/usetrawler\.com\/docs\/"[^>]*>.*?<\/a>/)?.[0];
  if (!link) throw new Error("no link to the docs in the header");
  return link;
}

describe("AppShell", () => {
  it("links to the product docs in a new tab, and says so to a screen reader", () => {
    const link = docsLink(renderToStaticMarkup(createElement(AppShell, { organization: "acme-org", email: "ana@example.com", children: "page" })));
    expect(link).toMatch(/>Docs</);
    expect(link).toContain('target="_blank"');
    expect(link).toMatch(/rel="[^"]*\bnoreferrer\b[^"]*"/);
    expect(link).toContain('<span aria-hidden="true"> ↗</span>');
    expect(link).toMatch(/<span class="sr-only[^"]*"> \(opens in a new tab\)<\/span>/);
  });
});
