import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { CaptureFrame, FindingScreenshots } from "./finding-screenshots.tsx";

const REPORTED = "11111111-1111-4111-8111-111111111111";
const REPLAYED = "22222222-2222-4222-8222-222222222222";
const render = (reported: string | null, replayed: string | null) => renderToStaticMarkup(createElement(FindingScreenshots, { title: "Save fails", screenshots: { reported, replayed } }));
const figures = (html: string) => html.match(/<figure.*?<\/figure>/g) ?? [];

test("a replayed defect shows the page when it was reported next to where the replay ended, side by side only when the card is wide enough, with their captions level", () => {
  const html = render(REPORTED, REPLAYED);
  expect(html).toMatch(/^<div class="@container [^"]*"><div class="grid gap-3 @xl:grid-cols-2">/);
  expect(html).not.toMatch(/\bsm:grid-cols-2\b/);
  const [reported, replayed] = figures(html);
  expect(reported).toMatch(/^<figure class="[^"]*\brow-span-2 grid\b[^"]*\bgrid-rows-subgrid\b/);
  expect(reported).toMatch(/<figcaption[^>]*><span>Screen capture · when reported<\/span><span aria-hidden="true">↗<\/span><\/figcaption>/);
  expect(replayed).toContain("<span>Screen capture · where the replay ended</span>");
  expect(replayed).toContain('alt="The page where the replay of “Save fails” ended"');
});

test("each capture keeps its 16:9 place while it loads, nothing covers it, and the whole frame opens a page that stays valid in a new tab", () => {
  const [reported] = figures(render(REPORTED, null));
  expect(reported).toMatch(new RegExp(`<a href="/captures/${REPORTED}" target="_blank" rel="noreferrer"[^>]*><img src="/api/artifacts/${REPORTED}" alt="The page when “Save fails” was reported" width="1280" height="720" loading="lazy"[^>]*/><span class="sr-only"> \\(opens in a new tab\\)</span></a>`));
  expect(reported).toMatch(/^<figure class="relative\b/);
  expect(reported).toMatch(/<a href="\/captures\/[^"]*" [^>]*class="[^"]*\bafter:absolute after:inset-0\b/);
  expect(reported).not.toMatch(/class="[^"]*(?<!after:)\babsolute\b/);
});

test("the captures say that passwords and other secrets are blacked out, a single capture takes the whole width, and a finding without any shows nothing", () => {
  const html = render(REPORTED, null);
  expect(html).toContain(">Passwords and other secrets are blacked out in screen captures.</p>");
  expect(figures(html)).toHaveLength(1);
  expect(html).not.toContain("grid-cols-2");
  expect(figures(render(null, REPLAYED))[0]).toContain("where the replay ended");
  expect(render(null, null)).toBe("");
});

test("a capture that fails to load says it could not be loaded instead of showing a broken image", () => {
  const shot = { id: REPORTED, caption: "when reported", alt: "The page" };
  const onFailed = vi.fn();
  const image = findImage(CaptureFrame({ shot, failed: false, onFailed })) as ReactElement<{ src: string; onError: () => void }> | null;
  expect(image?.props.src).toBe(`/api/artifacts/${REPORTED}`);
  image!.props.onError();
  expect(onFailed).toHaveBeenCalledOnce();
  const gone = renderToStaticMarkup(CaptureFrame({ shot, failed: true, onFailed }) as ReactElement);
  expect(gone).toContain(">This screen capture could not be loaded.</p>");
  expect(gone).not.toContain("<img");
  expect(gone).not.toContain("↗");
});

test("a capture that failed before the page became interactive is noticed once it does, while one still loading or loaded is left alone", () => {
  const shot = { id: REPORTED, caption: "when reported", alt: "The page" };
  const onFailed = vi.fn();
  const image = findImage(CaptureFrame({ shot, failed: false, onFailed })) as ReactElement<{ ref: (img: Partial<HTMLImageElement> | null) => void }> | null;
  image!.props.ref({ complete: false, naturalWidth: 0 });
  image!.props.ref({ complete: true, naturalWidth: 1280 });
  image!.props.ref(null);
  expect(onFailed).not.toHaveBeenCalled();
  image!.props.ref({ complete: true, naturalWidth: 0 });
  expect(onFailed).toHaveBeenCalledOnce();
});

function findImage(node: unknown): ReactElement | null {
  if (!node || typeof node !== "object") return null;
  const element = node as ReactElement<{ children?: unknown }>;
  if (element.type === "img") return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findImage(child);
    if (found) return found;
  }
  return null;
}
