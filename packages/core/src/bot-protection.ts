export interface BotProtection {
  vendor: string;
  url: string;
}

export interface Detected {
  vendor: string;
  stops: boolean;
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
  ".cf-turnstile",
  "#px-captcha",
  "#sec-if-cpt-container",
  "#captcha-container",
] as const;

type Rule = { vendor: string; stops: boolean; matches: (page: PageSignals) => boolean };

const visibleFrame = (page: PageSignals, pattern: RegExp) => page.frames.some((f) => f.visible && pattern.test(f.src));
const anySource = (page: PageSignals, pattern: RegExp) => page.scripts.some((s) => pattern.test(s)) || page.frames.some((f) => pattern.test(f.src));
const has = (page: PageSignals, selector: (typeof BOT_PROTECTION_SELECTORS)[number]) => page.selectors.includes(selector);

const RULES: Rule[] = [
  {
    vendor: "Cloudflare",
    stops: true,
    matches: (p) =>
      /^(just a moment(\.\.\.|…)|attention required! \| cloudflare)$/i.test(p.title.trim()) ||
      anySource(p, /\/cdn-cgi\/challenge-platform\/.*\/orchestrate\/(chl_page|managed|jsch|captcha)\//) ||
      has(p, "#challenge-form") ||
      has(p, "#challenge-running") ||
      has(p, "#challenge-stage"),
  },
  { vendor: "DataDome", stops: true, matches: (p) => anySource(p, /captcha-delivery\.com\//) },
  { vendor: "PerimeterX", stops: true, matches: (p) => has(p, "#px-captcha") },
  { vendor: "Akamai", stops: true, matches: (p) => has(p, "#sec-if-cpt-container") || (/^access denied$/i.test(p.title.trim()) && /reference #[\d.a-f]+/i.test(p.text)) },
  { vendor: "Imperva", stops: true, matches: (p) => /incapsula incident id/i.test(p.text) || p.frames.some((f) => /_Incapsula_Resource\?.*CWUDNSAI/.test(f.src)) },
  { vendor: "AWS WAF", stops: true, matches: (p) => anySource(p, /\.awswaf\.com\//) && (has(p, "#captcha-container") || /^human verification$/i.test(p.title.trim())) },
  { vendor: "Cloudflare Turnstile", stops: false, matches: (p) => visibleFrame(p, /challenges\.cloudflare\.com\//) || has(p, ".cf-turnstile") },
  { vendor: "reCAPTCHA", stops: false, matches: (p) => p.frames.some((f) => f.visible && /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/.test(f.src) && !/[?&]size=invisible/.test(f.src)) },
  { vendor: "hCaptcha", stops: false, matches: (p) => visibleFrame(p, /hcaptcha\.com\/.*(checkbox|challenge)/) },
];

export function botProtection(page: PageSignals): Detected | null {
  const rule = RULES.find((r) => r.matches(page));
  return rule ? { vendor: rule.vendor, stops: rule.stops } : null;
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

const WIDGET_ORIGINS: Record<string, string[]> = {
  "Cloudflare Turnstile": ["https://challenges.cloudflare.com"],
  reCAPTCHA: ["https://www.google.com", "https://www.recaptcha.net"],
  hCaptcha: ["https://hcaptcha.com", "https://newassets.hcaptcha.com"],
};

const WIDGET_SELECTOR = '.cf-turnstile, .g-recaptcha, .h-captcha, iframe[src*="challenges.cloudflare.com"], iframe[src*="/recaptcha/"], iframe[src*="hcaptcha.com"]';

export const FORM_HOLDS_WIDGET = `(el, action) => {
  if (!el || !el.closest) return false;
  const controls = 'button, input[type="submit"], input[type="image"], [role="button"]';
  if (action === "click" && !el.closest(controls)) return false;
  return [...document.querySelectorAll(${JSON.stringify(WIDGET_SELECTOR)})].some((widget) => {
    let scope = widget.parentElement;
    while (scope && scope !== document.body && scope !== document.documentElement && !scope.querySelector(controls)) scope = scope.parentElement;
    if (!scope || scope === document.body || scope === document.documentElement) return false;
    return scope.contains(el) || (!!el.form && !el.form.contains(el) && el.form.contains(widget));
  });
}`;

export function widgetCanLoad(vendor: string, isAllowed: (url: string) => boolean): boolean {
  return (WIDGET_ORIGINS[vendor] ?? []).some((origin) => isAllowed(origin));
}

export function botProtectionNote(found: Detected, widgetLoads = true): string {
  if (!found.stops && !widgetLoads) return `### Bot protection\nThis page has a ${found.vendor} check, and it cannot load in this browser, so a form that needs it will not go through. That says nothing about the product: do not try to get past it and do not report the check or the form behind it as a finding. Go on with a goal that does not need it.`;
  return found.stops
    ? `### Bot protection\nThis page is ${found.vendor}'s bot-protection check. It stops automated browsers like this one, and a person in an ordinary browser gets past it, so it says nothing about the product. Do not try to get past it and do not report it as a finding. Mark the goal you are on as failed with the note "blocked by bot protection", and go on with a goal that does not need this page.`
    : `### Bot protection\nThis page has a ${found.vendor} check. If it stops you from going on, that says nothing about the product: do not try to get past it and do not report the check as a finding. Go on with a goal that does not need it.`;
}

export function botProtectionRefusal(current: BotProtection | null): string | null {
  if (!current) return null;
  return `rejected: ${current.vendor}'s bot-protection check at ${current.url} stops automated browsers like yours, and a person in an ordinary browser gets past it, so it is not a finding about the product. Mark the goal you are on as failed with the note "blocked by bot protection", and go on with a goal that does not need that page.`;
}

export function clearedNote(vendor: string): string {
  return `### Bot protection\n${vendor}'s bot-protection check let the browser through while Trawler waited, so what is shown above may be the check rather than the page. Take a browser_snapshot to see the page now.`;
}
