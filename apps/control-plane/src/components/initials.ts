export function initials(text: string): string {
  const words = text.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean).map((word) => Array.from(word));
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? ["?"]).slice(0, 2).join("");
  return letters.toUpperCase();
}
