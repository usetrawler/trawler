import { format, inspect, type InspectOptions } from "node:util";

export const MASK = "•••";
export const MIN_SECRET_LENGTH = 8;

function jsonEscaped(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

function jsSingleQuoted(s: string): string {
  return jsonEscaped(s).replace(/\\"/g, '"').replace(/'/g, "\\'");
}

function htmlEscaped(s: string, apostrophe: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, apostrophe);
}

const wellFormed = (s: string) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");

function forms(s: string): string[] {
  const whole = wellFormed(s);
  const percent = [encodeURIComponent(whole), encodeURI(whole), new URLSearchParams({ x: whole }).toString().slice(2)];
  const lowerPercent = percent.map((p) => p.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  const html = ["&#39;", "&#x27;", "&apos;"].map((a) => htmlEscaped(s, a));
  return [s, jsonEscaped(s), jsonEscaped(jsonEscaped(s)), jsSingleQuoted(s), inspect(s).slice(1, -1), ...html, ...percent, ...lowerPercent];
}

export const asShown = (s: string) => s.replace(/\p{Default_Ignorable_Code_Point}/gu, "").replace(/\s+/g, " ").trim();

function variants(secret: string): string[] {
  const collapsed = secret.replace(/[\u200b\u00ad]/g, "").replace(/\s+/g, " ").trim();
  const extra = [...new Set([asShown(secret), collapsed])].filter((shown) => shown !== secret && shown.length >= MIN_SECRET_LENGTH);
  return [...new Set([secret, wellFormed(secret), ...extra])].flatMap((s) => [...forms(s), ...forms(s.normalize("NFC")), ...forms(s.normalize("NFD"))]);
}

const AUTH_SCHEME = /^\s*([A-Za-z][!#$%&'*+.^_`|~0-9A-Za-z-]*)\s+(\S(?:.*\S)?)\s*$/s;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function credentialParts(headerValue: string): string[] {
  const [, scheme, credential] = AUTH_SCHEME.exec(headerValue) ?? [];
  if (!scheme || !credential) return [];
  if (scheme.toLowerCase() !== "basic" || !BASE64.test(credential)) return [credential];
  const bytes = Buffer.from(credential, "base64");
  const utf8 = bytes.toString("utf8");
  return [credential, ...[utf8, ...(utf8.includes("\uFFFD") ? [bytes.toString("latin1")] : [])].flatMap(userAndPassword)];
}

function userAndPassword(decoded: string): string[] {
  const colon = decoded.indexOf(":");
  if (colon === -1) return [decoded];
  const password = decoded.slice(colon + 1);
  return [decoded, password.length >= MIN_SECRET_LENGTH ? password : decoded.slice(0, colon)];
}

function periodTail(needle: string): string {
  const border = new Array<number>(needle.length).fill(0);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = border[k - 1]!;
    if (needle[i] === needle[k]) k++;
    border[i] = k;
  }
  return needle.slice(border[needle.length - 1]!);
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export class SecretScrubber {
  #needles: string[] = [];
  #tails = new Map<string, string>();
  #browserNeedles: string[] = [];

  static forProject(project: {
    accounts: { password: string }[];
    httpCredentials?: { username: string; password: string };
    secretHeaders: Record<string, string>;
  }): SecretScrubber {
    const scrubber = new SecretScrubber();
    for (const account of project.accounts) if (account.password.length >= MIN_SECRET_LENGTH) scrubber.add(account.password);
    if (project.httpCredentials) {
      const { username, password } = project.httpCredentials;
      const basic = Buffer.from(`${username}:${password}`).toString("base64");
      if (password.length >= MIN_SECRET_LENGTH) scrubber.add(password);
      if (basic.length >= MIN_SECRET_LENGTH) scrubber.add(basic);
    }
    for (const value of Object.values(project.secretHeaders)) {
      scrubber.add(value);
      for (const part of credentialParts(value)) if (part.length >= MIN_SECRET_LENGTH) scrubber.add(part);
    }
    return scrubber;
  }

  add(secret: string, { reachesBrowser = true }: { reachesBrowser?: boolean } = {}): void {
    if (secret.length < MIN_SECRET_LENGTH) throw new RangeError(`secrets must be at least ${MIN_SECRET_LENGTH} characters to be scrubbed reliably`);
    const found = variants(secret).filter((n) => n.length > 0);
    this.#needles = [...new Set([...this.#needles, ...found])];
    for (const needle of found) if (!this.#tails.has(needle)) this.#tails.set(needle, periodTail(needle));
    if (reachesBrowser) this.#browserNeedles = [...new Set([...this.#browserNeedles, ...found])];
  }

  browserNeedles(): string[] {
    return [...this.#browserNeedles];
  }

  scrub<T>(value: T): T {
    return this.#scrub(value, new WeakSet()) as T;
  }

  #scrubText(input: string): string {
    const text = input;
    const ranges: Array<[number, number]> = [];
    for (const needle of this.#needles) {
      const tail = this.#tails.get(needle) ?? needle;
      let found: [number, number] | undefined;
      for (let at = text.indexOf(needle); at !== -1; ) {
        let end = at + needle.length;
        while (text.startsWith(tail, end)) end += tail.length;
        if (found && at <= found[1]) found[1] = end;
        else ranges.push((found = [at, end]));
        at = text.indexOf(needle, end - needle.length + 1);
      }
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

  #scrub(value: unknown, ancestors: WeakSet<object>): unknown {
    if (typeof value === "string") return this.#scrubText(value);
    if (typeof value === "function") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (ancestors.has(value)) return "[circular]";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => this.#scrub(v, ancestors));
      if (value instanceof Error) return { name: this.#scrubText(value.name), message: this.#scrubText(value.message) };
      if (value instanceof Uint8Array || value instanceof DataView) return this.#scrubText(new TextDecoder().decode(value));
      if (ArrayBuffer.isView(value)) return "[binary]";
      if (value instanceof ArrayBuffer) return this.#scrubText(new TextDecoder().decode(new Uint8Array(value)));
      if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.#scrubText(k), this.#scrub(v, ancestors)]));
      }
      return this.#scrubText(String(value));
    } catch {
      return "[unserialisable]";
    } finally {
      ancestors.delete(value);
    }
  }
}

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
let consoleScrubbed = false;

export function scrubConsole(scrubber: Pick<SecretScrubber, "scrub">): void {
  if (consoleScrubbed) return;
  consoleScrubbed = true;
  for (const level of CONSOLE_LEVELS) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]) => write(scrubber.scrub(format(...args)));
  }
  console.dir = (item: unknown, options?: InspectOptions) => console.log(inspect(item, { customInspect: false, ...options }));
  console.dirxml = (...data: unknown[]) => console.log(...data);
}
