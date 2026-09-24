const MASK = "•••";
export const MIN_SECRET_LENGTH = 8;

function jsonEscaped(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

function jsSingleQuoted(s: string): string {
  return jsonEscaped(s).replace(/\\"/g, '"').replace(/'/g, "\\'");
}

function htmlEscaped(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function variants(secret: string): string[] {
  const s = secret.normalize("NFC");
  const percent = [encodeURIComponent(s), encodeURI(s), new URLSearchParams({ x: s }).toString().slice(2)];
  const lowerPercent = percent.map((p) => p.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  return [s, jsonEscaped(s), jsonEscaped(jsonEscaped(s)), jsSingleQuoted(s), htmlEscaped(s), ...percent, ...lowerPercent];
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export class SecretScrubber {
  #needles: string[] = [];

  static forProject(project: {
    accounts: { password: string }[];
    httpCredentials?: { username: string; password: string };
    extraHeaders: Record<string, string>;
  }): SecretScrubber {
    const scrubber = new SecretScrubber();
    for (const account of project.accounts) scrubber.add(account.password);
    if (project.httpCredentials) {
      const { username, password } = project.httpCredentials;
      const basic = Buffer.from(`${username}:${password}`).toString("base64");
      scrubber.add(password);
      scrubber.add(basic);
    }
    for (const value of Object.values(project.extraHeaders)) {
      if (value.length >= MIN_SECRET_LENGTH) scrubber.add(value);
    }
    return scrubber;
  }

  add(secret: string): void {
    if (secret.length < MIN_SECRET_LENGTH) throw new RangeError(`secrets must be at least ${MIN_SECRET_LENGTH} characters to be scrubbed reliably`);
    this.#needles = [...new Set([...this.#needles, ...variants(secret)])].filter((n) => n.length > 0);
  }

  scrub<T>(value: T): T {
    return this.#scrub(value, new WeakSet()) as T;
  }

  #scrubText(input: string): string {
    const text = input.normalize("NFC");
    const ranges: Array<[number, number]> = [];
    for (const needle of this.#needles) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) ranges.push([at, at + needle.length]);
    }
    if (ranges.length === 0) return text;
    ranges.sort((a, b) => a[0] - b[0]);
    let out = "";
    let cursor = 0;
    let [start, end] = ranges[0]!;
    for (const [s, e] of ranges.slice(1)) {
      if (s <= end) end = Math.max(end, e);
      else {
        out += text.slice(cursor, start) + MASK;
        cursor = end;
        [start, end] = [s, e];
      }
    }
    return out + text.slice(cursor, start) + MASK + text.slice(end);
  }

  #scrub(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.#scrubText(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => this.#scrub(v, seen));
    if (value instanceof Error) return { name: value.name, message: this.#scrubText(value.message) };
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.#scrub(v, seen)]));
    return this.#scrubText(String(value));
  }
}
