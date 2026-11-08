import { expect, test } from "vitest";
import { findingMarkdown, plain, type IssueFinding } from "./finding-markdown.ts";

const finding: IssueFinding = {
  title: "Saving an invoice fails",
  severity: "high",
  personaName: "Ana",
  goalText: "Send an invoice.",
  observed: "A 500 page.",
  reproduction: ["Open Invoices.", "Save."],
  page: "/invoices/new",
  quote: "I lost the whole invoice.",
  replay: { completed: true, observed: "The same 500 page.", blockedAt: null },
  screenshots: { reported: "r-1", replayed: "p-2" },
};
const where = { status: "Confirmed: reproduced independently", runTitle: "Run 0007", runUrl: "https://app.trawler.test/runs/0007#finding-ana-f1", origin: "https://app.trawler.test" };

test("an issue carries the title, what happened, numbered steps, what the replay saw, the person's words, the captures and a link back to the run", () => {
  expect(findingMarkdown(finding, where)).toBe([
    "## Saving an invoice fails",
    "",
    "**High** · Confirmed: reproduced independently · reported by Ana, while trying to: Send an invoice.",
    "Page: /invoices/new",
    "",
    "### What happened",
    "> A 500 page.",
    "",
    "### Steps to reproduce",
    "1. Open Invoices.",
    "2. Save.",
    "",
    "### What the replay saw",
    "> The same 500 page.",
    "",
    "> I lost the whole invoice.",
    "> — Ana",
    "",
    "Screen captures: [when reported](https://app.trawler.test/captures/r-1) · [where the replay ended](https://app.trawler.test/captures/p-2)",
    "Found by Trawler in [Run 0007](https://app.trawler.test/runs/0007#finding-ana-f1)",
  ].join("\n"));
});

test("a finding without a page, a replay, words or captures leaves those lines out", () => {
  const bare = findingMarkdown({ ...finding, page: null, replay: null, quote: null, screenshots: { reported: null, replayed: null } }, where);
  expect(bare).not.toMatch(/Page:|What the replay saw|Screen captures/);
  expect(bare.endsWith("2. Save.\n\nFound by Trawler in [Run 0007](https://app.trawler.test/runs/0007#finding-ana-f1)")).toBe(true);
});

test("text the agent wrote cannot mention people, link, embed images, add markup or leave its quote", () => {
  expect(plain("ping @octo and @org/team")).toBe("ping @​octo and @​org/team");
  expect(plain("![x](https://evil.test/p.png) [click](https://evil.test) <img src=x> `code` *bold* #12")).toBe("\\!\\[x\\](https://evil.test/p.png) \\[click\\](https://evil.test) \\<img src=x\\> \\`code\\` \\*bold\\* \\#12");
  const md = findingMarkdown({ ...finding, title: "Broken\n## Injected heading", reproduction: ["Open.\n- [ ] sneaky item"], quote: "first line\nsecond line\n# heading" }, where);
  expect(md).toContain("## Broken \\#\\# Injected heading\n");
  expect(md).toContain("1. Open. - \\[ \\] sneaky item\n");
  expect(md).toContain("> first line\n> second line\n> \\# heading\n> — Ana");
  expect(md.split("\n").filter((row) => row.startsWith("## "))).toHaveLength(1);
});
