import { describe, expect, test } from "vitest";
import { COMMENT_MARKER, renderComment } from "./comment.ts";
import { NOT_VISIBLE_HERE } from "./status.ts";

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

  test("says why a skipped run could not see the change in this setup", () => {
    const md = renderComment({ ...base, status: "cancelled", skipped: true, people: 0, goalsTotal: 0, goalsReached: 0, skipNote: `${NOT_VISIBLE_HERE} The member limit only exists on the hosted service.` });
    expect(md).toBe(`${COMMENT_MARKER}\n\n### ${NOT_VISIBLE_HERE}\n\nThe member limit only exists on the hosted service.\n\n[Full report](https://app.trawler.test/runs/0012)`);
  });

  test("does not call a run clean when most goals were not reached", () => {
    const md = renderComment({ ...base, people: 2, goalsReached: 1, goalsTotal: 7, unreachedGoals: ["You invite Maya to the team", "You open the board"] });
    expect(md).toContain("### Trawler could check only part of this change");
    expect(md).not.toContain("found no confirmed defects");
    expect(md).toContain("2 people used the product and reached 1 of 7 goals.");
    expect(md).toContain("finding no defect is not proof that the change works. Not checked:\n- You invite Maya to the team\n- You open the board");
    expect(renderComment({ ...base, goalsReached: 3, goalsTotal: 6 })).toContain("### Trawler found no confirmed defects");
    const withDefect = renderComment({ ...base, goalsReached: 1, goalsTotal: 7, defects: { confirmed: 1, refuted: 0, inconclusive: 0 }, confirmed: [{ title: "T", page: null, severity: "low", person: "Ana", observed: "x", steps: ["a"] }] });
    expect(withDefect).toContain("### Trawler: 1 defect confirmed by replay");
    expect(withDefect).toContain("other defects may be missing");
  });

  test("lists at most five unreached goals", () => {
    const md = renderComment({ ...base, goalsReached: 0, goalsTotal: 8, unreachedGoals: Array.from({ length: 8 }, (_, i) => `Goal ${i + 1}`) });
    expect(md).toContain("- Goal 5\n- and 3 more, in the report");
    expect(md).not.toContain("Goal 6");
  });

  test("says a skipped run was not started because nothing in the change can be tested through the UI", () => {
    const md = renderComment({ ...base, status: "cancelled", skipped: true, people: 0, goalsTotal: 0, goalsReached: 0 });
    expect(md).toBe(`${COMMENT_MARKER}\n\n### Nothing in this change can be tested through the product's UI, so Trawler did not start a run.\n\n[Full report](https://app.trawler.test/runs/0012)`);
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

  test("says when reports were left unverified instead of calling the run clean", () => {
    const md = renderComment({ ...base, people: 2, unverified: 1 });
    expect(md).toContain("### Trawler: 1 report not verified before the run ended");
    expect(md).not.toContain("found no confirmed defects");
    expect(md).toContain("1 reported defect could not be verified by replay");
    expect(renderComment({ ...base, unverified: 0 })).toContain("found no confirmed defects");
  });

  test("never calls a run clean when it stopped at its cap", () => {
    const empty = renderComment({ ...base, status: "stopped_budget" });
    expect(empty).toContain("### Trawler ran out of its budget before it finished testing this change");
    expect(empty).not.toContain("found no confirmed defects");
    expect(empty).toContain("The run stopped at its cap, so this is not a clean result.");
    const unreplayed = renderComment({ ...base, status: "stopped_budget", unverified: 3 });
    expect(unreplayed).toContain("### Trawler ran out of its budget before it finished testing this change");
    expect(unreplayed).toContain("3 reported defects were not replayed or judged, so they are not confirmed.");
    expect(unreplayed).not.toContain("could not be verified by replay");
    expect(renderComment({ ...base, status: "stopped_budget", unverified: 1 })).toContain("1 reported defect was not replayed or judged, so it is not confirmed.");
  });

  test("lists confirmed defects under the cap headline", () => {
    const md = renderComment({
      ...base, status: "stopped_budget", defects: { confirmed: 1, refuted: 0, inconclusive: 0 }, unverified: 2,
      confirmed: [{ title: "Save fails", page: "/settings", severity: "high", person: "Ana", observed: "A 500 error.", steps: ["Open /settings"] }],
    });
    expect(md).toContain("### Trawler ran out of its budget before it finished testing this change");
    expect(md).toContain("1 defect confirmed by replay so far.");
    expect(md).toContain("#### Save fails on `/settings`");
    expect(md).not.toContain("### Trawler: 1 defect confirmed by replay");
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
