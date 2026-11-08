import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/this-route-does-not-exist" }));

const { default: NotFound, metadata } = await import("./not-found.tsx");
const render = () => renderToStaticMarkup(createElement(NotFound));
const header = (html: string) => html.match(/<header[^>]*>(?:(?!<\/header>).)*<\/header>/)?.[0] ?? "";

test("a missing page says so in one calm title, shows the address asked for, and leads back into the app first", () => {
  const html = render();
  expect(html).toContain(">Error 404</p>");
  expect(html).toMatch(/<h1 class="[^"]*\bmd:text-\[28px\][^"]*">This page does not exist\.<\/h1>/);
  expect(html).toContain(">The address may be wrong, or the page may have moved.</p>");
  expect(html).toMatch(/<code [^>]*class="[^"]*\bfont-mono\b/);
  expect([...html.matchAll(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], m[2]!.replace(/<[^>]+>/g, "")])).toEqual([
    ["/", "trawler"], ["/", "Open Trawler"], ["https://usetrawler.com/", "usetrawler.com"], ["mailto:contact@usetrawler.com", "Report a broken link"],
  ]);
  expect(html.match(/\bbg-action\b/g)).toHaveLength(1);
});

test("on a full page load the tab names the page, before its JavaScript runs and after Next draws it", () => {
  expect(metadata.title).toEqual({ absolute: "Page not found · Trawler" });
  expect(render()).toMatch(/^<title>Page not found · Trawler<\/title><div class="flex min-h-dvh /);
});

test("the header keeps the theme switch", () => {
  expect(header(render())).toMatch(/<button type="button" title="Theme: System\. Switch to Dark\."/);
});
