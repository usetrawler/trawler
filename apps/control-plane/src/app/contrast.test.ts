import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");
const block = (selector: string) => { const start = css.indexOf(`\n${selector}`); return css.slice(start, css.indexOf("}", start)); };
const token = (text: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(text)![1]!;
const themes = { light: block(":root {"), dark: block(':root[data-theme="dark"]'), "system dark": block('  :root:not([data-theme="light"])') };

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const mix = (a: string, b: string, t: number) => `#${channels(a).map((c, i) => Math.round(c * t + channels(b)[i]! * (1 - t)).toString(16).padStart(2, "0")).join("")}`;

test.each(Object.entries(themes))("small text in the %s theme meets 4.5:1 on the page, a panel and a hovered run row", (_, theme) => {
  const paper = token(theme, "paper");
  const panel = token(theme, "panel");
  const hovered = mix(token(theme, "action"), panel, 0.05);
  for (const name of ["action-ink", "ok", "warn", "bad", "info", "muted"]) {
    for (const background of [paper, panel, hovered]) expect(contrast(token(theme, name), background), `${name} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the bright orange colours only graphics; orange text uses the ink shade", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
  const bright = files.filter((f) => /(?<![\w-])text-action(?![\w-])/.test(readFileSync(`${src}/${f}`, "utf8"))).sort();
  expect(bright).toEqual(["app/sign-in/sign-in-buttons.tsx", "components/app-shell.tsx", "components/brand-mark.tsx"]);
});
