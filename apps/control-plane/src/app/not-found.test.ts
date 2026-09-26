import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/this-route-does-not-exist" }));

const { default: NotFound, metadata } = await import("./not-found.tsx");
const render = () => renderToStaticMarkup(createElement(NotFound));
const header = (html: string) => html.match(/<header[^>]*>(?:(?!<\/header>).)*<\/header>/)?.[0] ?? "";

test("a missing page says so in the mockup's words, with the way back into the app first", () => {
  const html = render();
  expect(html).toMatch(/<i aria-hidden="true" class="[^"]*"><\/i>Page not found<\/p>/);
  expect(html).toContain(">This route<br/>doesn’t exist.</h1>");
  expect(html).toContain(">The address may be wrong, or the page may have moved.</p>");
  expect([...html.matchAll(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], m[2]!.replace(/<[^>]+>[^<]*<\/[^>]+>|<[^>]+>/g, "")])).toEqual([
    ["/", "trawler"], ["/", "Open Trawler"], ["https://usetrawler.com/", "Visit usetrawler.com"], ["mailto:contact@usetrawler.com", "Report a broken link"],
  ]);
});

test("on a full page load the tab names the page, before its JavaScript runs and after Next draws it", () => {
  expect(metadata.title).toBe("Page not found · Trawler");
  expect(render()).toMatch(/^<title>Page not found · Trawler<\/title><div class="app-frame /);
});

test("the route check card holds the requested route, which the browser fills in, the broken route line, which high-contrast modes still draw, and the result", () => {
  expect(render()).toMatch(/<b class="[^"]*\bborder-t-2 border-transparent bg-origin-border\b[^"]*"><\/b>/);
  expect(render()).toMatch(/<section aria-label="Route check"[^>]*><div><p [^>]*>Requested route<\/p><code [^>]*><\/code><\/div><div aria-hidden="true"[^>]*>.*>×<\/strong><\/div><p [^>]*><span [^>]*>Result<\/span><b[^>]*>Not found<\/b><\/p><small[^>]*>Checked twice by Trawler\.<\/small><\/section>/);
});

test("the mockup's steps include their own widths: one column at 820 px, an iPad Air upright, and stacked actions and no report link at 520 px", () => {
  const html = render();
  expect(html).toMatch(/<main class="[^"]*\bmax-\[821px\]:grid-cols-1\b/);
  expect(html).toMatch(/<div class="[^"]*\bmax-\[521px\]:flex-col\b[^"]*"><a href="\/"/);
  expect(html).toMatch(/<a href="mailto:contact@usetrawler\.com" class="[^"]*\bmax-\[521px\]:hidden\b/);
  expect(html).not.toMatch(/max-\[820px\]|max-\[520px\]/);
});

test("the two actions wrap as whole buttons where a row has no room for both", () => {
  const html = render();
  expect(html).toMatch(/<div class="[^"]*\bflex-wrap\b[^"]*"><a href="\/" class="[^"]*\bwhitespace-nowrap\b[^"]*">Open Trawler/);
  expect(html).toMatch(/<a href="https:\/\/usetrawler\.com\/" class="[^"]*\bwhitespace-nowrap\b[^"]*">Visit usetrawler\.com<\/a>/);
});

test("the header keeps the theme switch, the big number is hidden from screen readers and from high-contrast modes, and the page closes up without it", () => {
  const html = render();
  expect(html).not.toContain("row-start");
  expect(html).toMatch(/<a href="\/" class="[^"]*\bborder border-transparent\b[^"]*">Open Trawler/);
  expect(header(html)).toMatch(/<button type="button" title="Theme: System\. Switch to Dark\."/);
  expect(html).toMatch(/<div aria-hidden="true" class="[^"]*\bforced-colors:hidden\b[^"]*">404<\/div>/);
  expect(html).toContain(">HTTP 404</span>");
});
