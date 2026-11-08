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

export const plain = (text: string) =>
  text
    .replace(/[\\`*_[\]<>|~#]/g, "\\$&")
    .replace(/!/g, "\\!")
    .replace(/@(?=\w)/g, "@\u200b");

const line = (text: string) => plain(text.replace(/\s+/g, " ").trim());

const quoted = (text: string) => plain(text.trim()).split(/\r?\n/).map((row) => `> ${row}`.trimEnd());

export function findingMarkdown(f: IssueFinding, where: { status: string; runTitle: string; runUrl: string; origin: string }): string {
  const replayed = (f.replay as { observed?: string } | null)?.observed;
  const captures = [
    f.screenshots.reported && `[when reported](${where.origin}/captures/${f.screenshots.reported})`,
    f.screenshots.replayed && `[where the replay ended](${where.origin}/captures/${f.screenshots.replayed})`,
  ].filter(Boolean);
  return [
    `## ${line(f.title)}`,
    "",
    `**${capitalised(f.severity)}** · ${where.status} · reported by ${line(f.personaName)}, while trying to: ${line(f.goalText)}`,
    ...(f.page ? [`Page: ${line(f.page)}`] : []),
    "",
    "### What happened",
    ...quoted(f.observed),
    "",
    "### Steps to reproduce",
    ...f.reproduction.map((step, i) => `${i + 1}. ${line(step)}`),
    ...(replayed ? ["", "### What the replay saw", ...quoted(replayed)] : []),
    ...(f.quote ? ["", ...quoted(f.quote), `> — ${line(f.personaName)}`] : []),
    "",
    ...(captures.length > 0 ? [`Screen captures: ${captures.join(" · ")}`] : []),
    `Found by Trawler in [${where.runTitle}](${where.runUrl})`,
  ].join("\n");
}
