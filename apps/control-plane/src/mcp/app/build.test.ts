import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { buildRunReportModule } from "../../../scripts/mcp-app-build.ts";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("the committed run report page is what its source builds to", async () => {
  expect(read("./run-report.generated.ts")).toBe(await buildRunReportModule());
});

test("the page source writes the text of a finding only as text, never as markup, and reaches for nothing from outside", () => {
  for (const name of ["./main.ts", "./dom.ts", "./ui.ts", "./report.ts", "./compare.ts", "./runs.ts", "./projects.ts", "./finding.ts", "./control.ts", "./evidence.ts", "./types.ts", "./host.ts"]) {
    const source = read(name);
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "srcdoc", "javascript:", "fetch(", "XMLHttpRequest", "WebSocket", "localStorage", "document.cookie"]) expect(source, `${name} uses ${forbidden}`).not.toContain(forbidden);
  }
  const template = read("./template.ts");
  expect(template).not.toMatch(/url\(|@import/);
  expect(template).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=["']https?:/i);
  expect(template).not.toContain("@import");
});
