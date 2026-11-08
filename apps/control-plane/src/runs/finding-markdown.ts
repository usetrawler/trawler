export interface IssueFinding {
  title: string;
  severity: string;
  personaName: string;
  goalText: string;
  observed: string;
  reproduction: string[];
  page: string | null;
  quote: string | null;
  replay: unknown;
  screenshots: { reported: string | null; replayed: string | null };
}

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export function findingMarkdown(f: IssueFinding, where: { status: string; runTitle: string; runUrl: string; origin: string }): string {
  const replayed = (f.replay as { observed?: string } | null)?.observed;
  const captures = [
    f.screenshots.reported && `[when reported](${where.origin}/captures/${f.screenshots.reported})`,
    f.screenshots.replayed && `[where the replay ended](${where.origin}/captures/${f.screenshots.replayed})`,
  ].filter(Boolean);
  return [
    `## ${f.title}`,
    "",
    `**${capitalised(f.severity)}** · ${where.status} · reported by ${f.personaName}, while trying to: ${f.goalText}`,
    ...(f.page ? [`Page: \`${f.page}\``] : []),
    "",
    "### What happened",
    f.observed,
    "",
    "### Steps to reproduce",
    ...f.reproduction.map((step, i) => `${i + 1}. ${step}`),
    ...(replayed ? ["", "### What the replay saw", replayed] : []),
    ...(f.quote ? ["", `> ${f.quote}`, `> — ${f.personaName}`] : []),
    "",
    ...(captures.length > 0 ? [`Screen captures: ${captures.join(" · ")}`] : []),
    `Found by Trawler in [${where.runTitle}](${where.runUrl})`,
  ].join("\n");
}
