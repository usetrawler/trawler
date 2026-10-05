import { describe, expect, test } from "vitest";
import { COMMENT_MARKER, renderComment } from "./comment.ts";

const base = {
  id: "7b0b2f56-5d3e-4c5c-9f49-2b0a1d2e3f40", number: 12, status: "succeeded" as const, finished: true, reportUrl: "https://app.trawler.test/runs/0012",
  people: 3, goalsReached: 5, goalsTotal: 6, defects: { confirmed: 0, refuted: 0, inconclusive: 0 }, confirmed: [], costUsd: 0.4231,
};

describe("renderComment", () => {
  test("lists each confirmed defect with steps, people, cost and the report link", () => {
    const md = renderComment({
      ...base,
      defects: { confirmed: 2, refuted: 1, inconclusive: 0 },
      confirmed: [
        { title: "Save <fails>", page: "/settings", severity: "high", person: "Ana, Lee", observed: "A 500 error\nappeared.", steps: ["Open /settings", "Click Save"] },
        { title: "Logo overlaps menu", page: null, severity: "low", person: "Lee", observed: "It overlaps.", steps: ["Open /"] },
      ],
    });
    expect(md.startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
    expect(md).toContain("### Trawler: 2 defects confirmed by replay");
    expect(md).toContain("#### Save &lt;fails&gt; on `/settings`");
    expect(md).toContain("Found by Ana, Lee (high severity). A 500 error appeared.");
    expect(md).toContain("<details>\n<summary>Steps to reproduce</summary>\n\n1. Open /settings\n2. Click Save\n\n</details>");
    expect(md).toContain("#### Logo overlaps menu\n");
    expect(md).toContain("3 people used the product and reached 5 of 6 goals. Cost $0.42.");
    expect(md).toContain("[Full report](https://app.trawler.test/runs/0012)");
  });

  test("does not call a run clean when people could not finish", () => {
    const md = renderComment({ ...base, people: 2, goalsReached: 5, goalsTotal: 12, peopleFailed: 2 });
    expect(md).toContain("### Trawler could not finish testing this change");
    expect(md).not.toContain("found no confirmed defects");
    expect(md).toContain("2 people could not finish");
    const withDefect = renderComment({ ...base, defects: { confirmed: 1, refuted: 0, inconclusive: 0 }, confirmed: [{ title: "T", page: null, severity: "low", person: "Ana", observed: "x", steps: ["a"] }], peopleFailed: 1 });
    expect(withDefect).toContain("### Trawler: 1 defect confirmed by replay");
    expect(withDefect).toContain("1 person could not finish");
  });

  test("says so when nothing was confirmed", () => {
    const md = renderComment({ ...base, defects: { confirmed: 0, refuted: 2, inconclusive: 1 } });
    expect(md).toContain("### Trawler found no confirmed defects");
    expect(md).toContain("Also reported: 2 reports refuted on replay, 1 inconclusive.");
  });

  test("does not claim a verdict while the run is going", () => {
    const md = renderComment({ ...base, status: "running", finished: false });
    expect(md).toContain("### Trawler is still testing this change");
    expect(md).not.toContain("no confirmed");
  });
});
