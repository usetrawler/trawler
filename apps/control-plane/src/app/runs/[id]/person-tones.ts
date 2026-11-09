export interface PersonTone {
  bar: string;
  tint: string;
  text: string;
  onBar: string;
}

const mix = (color: string, share: number, base = "var(--panel)") => `color-mix(in srgb, ${color} ${share}%, ${base})`;

export const PERSON_TONES: PersonTone[] = [
  { bar: "var(--action)", tint: mix("var(--action)", 10), text: "var(--action-ink)", onBar: "#171717" },
  { bar: "var(--ink)", tint: mix("var(--ink)", 6), text: "var(--ink)", onBar: "var(--panel)" },
  { bar: "var(--muted)", tint: mix("var(--muted)", 9), text: "var(--muted)", onBar: "var(--panel)" },
  { bar: mix("var(--action)", 45), tint: mix("var(--action)", 6), text: "var(--action-ink)", onBar: "var(--ink)" },
  { bar: mix("var(--action-ink)", 65, "var(--ink)"), tint: mix("var(--action-ink)", 8), text: "var(--action-ink)", onBar: "var(--panel)" },
  { bar: mix("var(--muted)", 45), tint: mix("var(--muted)", 5), text: "var(--muted)", onBar: "var(--ink)" },
];

export const toneOf = (index: number): PersonTone => PERSON_TONES[((index % PERSON_TONES.length) + PERSON_TONES.length) % PERSON_TONES.length]!;

export const SYSTEM_TONE: PersonTone = { bar: mix("var(--muted)", 40), tint: "var(--soft)", text: "var(--muted)", onBar: "var(--panel)" };

export const letterOf = (name: string) => (Array.from(name.trim())[0] ?? "?").toUpperCase();
