import type { RunResult } from "@usetrawler/protocol";
import { runView } from "./report.ts";
import type { RunSummary } from "./runs.ts";
import { NOTHING_TO_TEST, runPath } from "./status.ts";

export const COMMENT_MARKER = "<!-- trawler-ci -->";

type CommentInput = Omit<RunResult, "commentMarkdown"> & { peopleFailed?: number };

const plain = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function headline(r: CommentInput): string {
  if (!r.finished) return "Trawler is still testing this change";
  if (r.status === "failed" || r.status === "cancelled") return "Trawler could not finish testing this change";
  if (r.defects.confirmed === 0 && (r.peopleFailed ?? 0) > 0) return "Trawler could not finish testing this change";
  if (r.status === "stopped_budget") return "Trawler ran out of its budget before it finished testing this change";
  if (r.defects.confirmed === 0 && (r.unverified ?? 0) > 0) return `Trawler: ${count(r.unverified!, "report")} not verified before the run ended`;
  if (r.defects.confirmed > 0) return `Trawler: ${count(r.defects.confirmed, "defect")} confirmed by replay`;
  return "Trawler found no confirmed defects";
}

function budgetLine(r: CommentInput): string {
  const unverified = r.unverified ?? 0;
  const confirmed = r.defects.confirmed > 0 ? ` ${count(r.defects.confirmed, "defect")} confirmed by replay so far.` : "";
  const left = unverified > 0 ? ` ${count(unverified, "reported defect")} ${unverified === 1 ? "was" : "were"} not replayed or judged, so ${unverified === 1 ? "it is" : "they are"} not confirmed.` : "";
  return `The run stopped at its cap, so this is not a clean result.${confirmed}${left} Raise the cap or run again to finish.`;
}

function defectBlock(d: RunResult["confirmed"][number]): string {
  const where = d.page ? ` on \`${d.page.replace(/`/g, "'")}\`` : "";
  const steps = d.steps.map((s, i) => `${i + 1}. ${plain(s)}`).join("\n");
  return [
    `#### ${plain(d.title)}${where}`,
    `Found by ${plain(d.person)} (${d.severity} severity). ${plain(d.observed)}`,
    `<details>\n<summary>Steps to reproduce</summary>\n\n${steps}\n\n</details>`,
  ].join("\n\n");
}

export function renderComment(r: CommentInput): string {
  if (r.skipped) return [COMMENT_MARKER, `### ${NOTHING_TO_TEST}`, `[Full report](${r.reportUrl})`].join("\n\n");
  const sections = [COMMENT_MARKER, `### ${headline(r)}`];
  if (r.finished && r.status === "stopped_budget") sections.push(budgetLine(r));
  if (r.finished && r.confirmed.length > 0) sections.push(r.confirmed.map(defectBlock).join("\n\n"));
  if (r.finished && r.defects.confirmed === 0) {
    const others = [r.defects.refuted > 0 ? `${count(r.defects.refuted, "report")} refuted on replay` : "", r.defects.inconclusive > 0 ? `${r.defects.inconclusive} inconclusive` : ""].filter(Boolean);
    if (others.length > 0) sections.push(`Also reported: ${others.join(", ")}.`);
  }
  if (r.finished && (r.peopleFailed ?? 0) > 0) sections.push(`${count(r.peopleFailed!, "person", "people")} could not finish, for example because the model provider refused the key. See the report.`);
  if (r.finished && r.status !== "stopped_budget" && (r.unverified ?? 0) > 0) sections.push(`${count(r.unverified!, "reported defect")} could not be verified by replay before the run ended, for example because its cap ran out. They are not confirmed; see the report.`);
  if (r.finished) sections.push(`${count(r.people, "person", "people")} used the product and reached ${r.goalsReached} of ${r.goalsTotal} ${r.goalsTotal === 1 ? "goal" : "goals"}. Cost $${r.costUsd.toFixed(2)}.`);
  sections.push(`[Full report](${r.reportUrl})`);
  return sections.join("\n\n");
}

export function runResultOf(s: RunSummary, baseUrl: string): RunResult {
  const view = runView(s);
  const skipped = s.cancelReason === "nothing_to_test";
  const result: CommentInput = {
    id: s.id,
    number: s.number,
    status: s.status as RunResult["status"],
    finished: !view.live,
    reportUrl: `${baseUrl.replace(/\/+$/, "")}${runPath(s.number)}`,
    people: skipped ? 0 : s.personas.length,
    goalsReached: view.goalsReached,
    goalsTotal: skipped ? 0 : view.goalsTotal,
    defects: { confirmed: view.report.confirmed.length, refuted: view.report.refuted.length, inconclusive: view.report.inconclusive.length },
    confirmed: view.report.confirmed.map((f) => ({
      title: f.title,
      page: f.page,
      severity: f.severity,
      person: [...new Set([f.personaName, ...f.sameReports.map((o) => o.personaName)])].join(", "),
      observed: f.observed,
      steps: f.reproduction,
    })),
    costUsd: s.costUsd,
    unverified: view.report.couldNotJudge.length + view.report.notJudged.length,
    ...(skipped ? { skipped: true } : {}),
  };
  return { ...result, commentMarkdown: renderComment({ ...result, peopleFailed: view.personas.filter((p) => p.state === "failed").length }) };
}
