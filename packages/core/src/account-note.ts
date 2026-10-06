import type { StoryEntry } from "@usetrawler/protocol";

export interface AccountField {
  label: string;
  value: string;
}

export interface AccountRecord {
  page?: string;
  fields: AccountField[];
}

export interface AccountFormRead {
  fields: Array<{ label: string; value: string; type: string; autocomplete: string; name: string }>;
}

const PREFIX = "Account form filled with your own password";
const MAX_FIELDS = 3;
const MAX_LABEL = 24;
const MAX_VALUE = 60;
const MAX_PAGE = 120;
const NOTE_FORMAT = new RegExp(`^${PREFIX}(?: on (\\S+))?: (.+)$`);
const FIELD_FORMAT = /(?:^|, )([^",]+?) ("(?:[^"\\]|\\.)*")(?=, |$)/g;
const USERNAME_LIKE = /user|login|handle|nick|account|screen/i;
const EMAIL_LIKE = /e-?mail/i;

const cleanLabel = (label: string) => label.replace(/["',:]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL).trim() || "field";

export function accountFields(read: AccountFormRead): AccountField[] {
  const classed = read.fields.map((f) => {
    const hint = `${f.label} ${f.name} ${f.autocomplete}`;
    const rank = f.autocomplete === "username" || USERNAME_LIKE.test(hint) ? 0 : f.type === "email" || f.autocomplete === "email" || EMAIL_LIKE.test(hint) ? 1 : 2;
    return { rank, label: cleanLabel(f.label), value: f.value.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE) };
  });
  const known = classed.filter((f) => f.rank < 2);
  return (known.length > 0 ? known : classed).sort((a, b) => a.rank - b.rank).slice(0, MAX_FIELDS).map(({ label, value }) => ({ label, value }));
}

export function accountNote(record: AccountRecord): string {
  const page = record.page ? ` on ${record.page.slice(0, MAX_PAGE)}` : "";
  return `${PREFIX}${page}: ${record.fields.map((f) => `${f.label} ${JSON.stringify(f.value)}`).join(", ")}`;
}

export function isAccountNote(text: string): boolean {
  return text.startsWith(PREFIX);
}

export function parseAccountNote(text: string): AccountRecord | null {
  const match = NOTE_FORMAT.exec(text);
  if (!match) return null;
  const fields: AccountField[] = [];
  for (const field of match[2]!.matchAll(FIELD_FORMAT)) {
    try {
      fields.push({ label: field[1]!, value: JSON.parse(field[2]!) as string });
    } catch {
      return null;
    }
  }
  return fields.length > 0 ? { ...(match[1] ? { page: match[1] } : {}), fields } : null;
}

export function accountFromStory(story: StoryEntry[], personaId: string): AccountRecord | null {
  for (const entry of [...story].reverse()) {
    if (entry.personaId !== personaId || entry.goal || !isAccountNote(entry.text)) continue;
    const record = parseAccountNote(entry.text);
    if (record) return record;
  }
  return null;
}

export function identityOf(record: AccountRecord): AccountField {
  return record.fields.find((f) => USERNAME_LIKE.test(f.label)) ?? record.fields.find((f) => EMAIL_LIKE.test(f.label)) ?? record.fields[0]!;
}
