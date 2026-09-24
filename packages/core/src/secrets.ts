const MASK = "•••";

function variants(secret: string): string[] {
  const html = secret.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), html];
}

export class SecretScrubber {
  #needles: string[] = [];

  add(secret: string): void {
    if (secret.length < 4) return;
    const next = new Set([...this.#needles, ...variants(secret)]);
    this.#needles = [...next].sort((a, b) => b.length - a.length);
  }

  scrub<T>(value: T): T {
    if (typeof value === "string") {
      let s: string = value;
      for (const needle of this.#needles) s = s.split(needle).join(MASK);
      return s as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.scrub(v)])) as T;
    }
    return value;
  }
}
