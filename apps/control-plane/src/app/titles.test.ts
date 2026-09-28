import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

vi.mock("../server/sentry.ts", () => ({ sentryMeta: () => null }));
vi.mock("next/font/google", () => ({ Instrument_Sans: () => ({ variable: "" }), JetBrains_Mono: () => ({ variable: "" }) }));

const app = fileURLToPath(new URL(".", import.meta.url));
const pages = readdirSync(app, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("page.tsx")).sort();
const source = (page: string) => readFileSync(`${app}/${page}`, "utf8");
const staticTitle = (page: string) => /export const metadata: Metadata = \{ title: ("[^"]+"|\{ absolute: "[^"]+" \}) \};/.exec(source(page))?.[1];
const dynamicTitle = (page: string) => /export async function generateMetadata\([^)]*\): Promise<Metadata> \{\n {2}const \{ id \} = await params;\n {2}return (\w+)\(await headers\(\), id(?:, "(\w+)")?\);\n\}/.exec(source(page))?.slice(1);

test("every page is named in its tab as the page, then Trawler; the overview spells it out, as the layout's template skips the layout's own segment", async () => {
  const { generateMetadata } = await import("./layout.tsx");
  expect(generateMetadata().title).toEqual({ default: "Trawler", template: "%s · Trawler" });
  expect(Object.fromEntries(pages.map((p) => [p, staticTitle(p) ?? dynamicTitle(p)]))).toEqual({
    "captures/[id]/page.tsx": ["capturePageTitle", undefined],
    "new/page.tsx": '"New project"',
    "page.tsx": '{ absolute: "Overview · Trawler" }',
    "projects/[id]/features/page.tsx": ["projectPageTitle", "Features"],
    "projects/[id]/page.tsx": ["projectPageTitle", "Plan"],
    "projects/[id]/runs/page.tsx": ["projectPageTitle", "Runs"],
    "runs/[id]/page.tsx": ["runPageTitle", undefined],
    "runs/page.tsx": '"Runs"',
    "settings/page.tsx": '"Settings"',
    "sign-in/page.tsx": '"Sign in"',
    "welcome/page.tsx": '"Choose your workspace"',
  });
});
