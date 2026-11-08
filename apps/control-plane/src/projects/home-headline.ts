import type { OpenFinding } from "./project-home.ts";

const listed = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function homeHeadline(findings: OpenFinding[], runs: number, finished: number): string {
  if (runs === 0) return "No runs yet.";
  if (finished === 0) return "No run has completed yet.";
  if (findings.length === 0) return "No confirmed defects are open.";
  const count = findings.length === 1 ? "1 confirmed defect is open" : `${findings.length} confirmed defects are open`;
  const sources = [...new Set(findings.map((f) => f.source))];
  if (sources.length > 3) return `${count}, across ${sources.length} pull requests and plans.`;
  return `${count}, from ${listed(sources)}.`;
}
