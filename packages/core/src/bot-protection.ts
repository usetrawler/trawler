export interface BotProtection {
  vendor: string;
  url: string;
}

export interface PageSignals {
  title: string;
  text: string;
  frames: Array<{ src: string; visible: boolean }>;
  scripts: string[];
  selectors: string[];
}

export const BOT_PROTECTION_SELECTORS = [
  "#challenge-form",
  "#challenge-running",
  "#challenge-stage",
  "#px-captcha",
  "#sec-if-cpt-container",
  "#captcha-container",
] as const;

type Rule = { vendor: string; matches: (page: PageSignals) => boolean };

const anySource = (page: PageSignals, pattern: RegExp) => page.scripts.some((s) => pattern.test(s)) || page.frames.some((f) => pattern.test(f.src));
const has = (page: PageSignals, selector: (typeof BOT_PROTECTION_SELECTORS)[number]) => page.selectors.includes(selector);

const RULES: Rule[] = [
  {
    vendor: "Cloudflare",
    matches: (p) =>
      /^(just a moment(\.\.\.|…)|attention required! \| cloudflare)$/i.test(p.title.trim()) ||
      anySource(p, /\/cdn-cgi\/challenge-platform\/.*\/orchestrate\/(chl_page|managed|jsch|captcha)\//) ||
      has(p, "#challenge-form") ||
      has(p, "#challenge-running") ||
      has(p, "#challenge-stage"),
  },
  { vendor: "DataDome", matches: (p) => anySource(p, /captcha-delivery\.com\//) },
  { vendor: "PerimeterX", matches: (p) => has(p, "#px-captcha") },
  { vendor: "Akamai", matches: (p) => has(p, "#sec-if-cpt-container") || (/^access denied$/i.test(p.title.trim()) && /reference #[\d.a-f]+/i.test(p.text)) },
  { vendor: "Imperva", matches: (p) => /incapsula incident id/i.test(p.text) || p.frames.some((f) => /_Incapsula_Resource\?.*CWUDNSAI/.test(f.src)) },
  { vendor: "AWS WAF", matches: (p) => anySource(p, /\.awswaf\.com\//) && (has(p, "#captcha-container") || /^human verification$/i.test(p.title.trim())) },
];

export function botProtection(page: PageSignals): string | null {
  return RULES.find((rule) => rule.matches(page))?.vendor ?? null;
}

export const COLLECT_PAGE_SIGNALS = `() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width >= 40 && r.height >= 40 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  return {
    title: document.title || "",
    text: (document.body?.innerText || "").slice(0, 4000),
    frames: [...document.querySelectorAll("iframe")].map((f) => ({ src: f.src || "", visible: visible(f) })),
    scripts: [...document.querySelectorAll("script[src]")].map((s) => s.src),
    selectors: ${JSON.stringify(BOT_PROTECTION_SELECTORS)}.filter((sel) => [...document.querySelectorAll(sel)].some(visible)),
  };
}`;

export function botProtectionNote(vendor: string): string {
  return `### Bot protection\nThis page is ${vendor}'s bot-protection check. It stops automated browsers like this one, and a person in an ordinary browser gets past it, so it says nothing about the product. Do not try to get past it and do not report it as a finding. Mark the goal you are on as failed with the note "blocked by bot protection", and go on with a goal that does not need this page.`;
}

export function botProtectionRefusal(current: BotProtection | null): string | null {
  if (!current) return null;
  return `rejected: ${current.vendor}'s bot-protection check at ${current.url} stops automated browsers like yours, and a person in an ordinary browser gets past it, so it is not a finding about the product. Mark the goal you are on as failed with the note "blocked by bot protection", and go on with a goal that does not need that page.`;
}

export function clearedNote(vendor: string): string {
  return `### Bot protection\n${vendor}'s bot-protection check let the browser through while Trawler waited, so what is shown above may be the check rather than the page. Take a browser_snapshot to see the page now.`;
}
