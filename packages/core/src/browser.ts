import { createMCPClient } from "@ai-sdk/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnection } from "@playwright/mcp";
import { chromium, type ElementHandle, type Frame, type Route } from "playwright";
import { jsonSchema, type Tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { MIN_SECRET_LENGTH, SecretScrubber } from "./secrets.ts";
import type { FieldKind } from "./session-tools.ts";

export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_wait_for",
  "browser_handle_dialog",
  "browser_file_upload",
] as const;

const FILE_PARAMETERS = ["filename", "paths"];
const SECRET_MARK = "data-trawler-secret";
const EDITS_FIELDS = new Set(["browser_type", "browser_select_option"]);
const STRIP_SPECULATION = `(() => {
  const strip = (root) => root.querySelectorAll?.('script[type="speculationrules"]').forEach((el) => el.remove());
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n instanceof HTMLScriptElement && n.type === "speculationrules") n.remove();
      else if (n instanceof Element) strip(n);
    }
  }).observe(document, { childList: true, subtree: true });
})();`;
const MAX_HELD_FIELDS = 20;
const KEYS_SAFE_ON_SECRETS = new Set(["Enter", "Tab", "Shift+Tab", "Escape"]);
const FOCUS_CHECK_MS = 2000;
const HANDLE_READ_MS = 500;
function fieldStateOf(el: any, mark: string) {
  return {
    marked: !!el && (el.hasAttribute?.(mark) || (el instanceof HTMLInputElement && el.type.toLowerCase() === "password")),
    value: !el ? "" : el.isContentEditable ? String(el.textContent ?? "") : typeof el.value === "string" ? el.value : "",
  };
}
const CLOSED = /Target page, context or browser has been closed|Browser has been closed/;
const INTERRUPTED = /is interrupted by another navigation/;
const DEEPEST_ACTIVE = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
})()`;

type FieldState = { marked: boolean; value: string };

function keptFrom(value: string, typed: string): boolean {
  let at = 0;
  for (const c of typed) if (c === value[at]) at++;
  return at === value.length;
}

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

async function focusIsOnSecretIn(frame: Frame, filled: ElementHandle[], holdsSecret: (value: string) => boolean, depth = 0): Promise<boolean> {
  if (depth > 10) return true;
  const active = (await frame.evaluateHandle(DEEPEST_ACTIVE)).asElement() as ElementHandle | null;
  if (!active) return false;
  const here: ElementHandle[] = [];
  for (const h of filled) if ((await h.ownerFrame().catch(() => null)) === frame) here.push(h);
  const held = await active.evaluate((el: unknown, others: unknown[]) => others.includes(el), here);
  const field = (await active.evaluate(fieldStateOf, SECRET_MARK).catch(() => null)) as FieldState | null;
  if (held || !field || field.marked || holdsSecret(field.value)) return true;
  for (const child of frame.childFrames()) {
    const owner = await child.frameElement().catch(() => null);
    if (owner && (await owner.evaluate((a: unknown, b: unknown) => a === b, active))) return focusIsOnSecretIn(child, filled, holdsSecret, depth + 1);
  }
  return false;
}

export interface Browser {
  tools: ToolSet;
  fillField(ref: string, text: string, kind: FieldKind): Promise<string>;
  close(): Promise<void>;
}

type McpResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

const internalCall = { toolCallId: "internal", messages: [], context: {} };

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function textOf(result: unknown): string {
  return ((result as McpResult)?.content ?? []).map((c) => c.text ?? "").join("\n");
}

function evaluatedValue(result: unknown): unknown {
  const match = /### Result\n([\s\S]*?)(?:\n###|$)/.exec(textOf(result));
  if (!match) return undefined;
  let value: unknown = match[1]!.trim();
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

function withoutFileParameters(t: Tool): Tool {
  const schema = (t.inputSchema as { jsonSchema?: { properties?: Record<string, unknown>; required?: string[] } }).jsonSchema;
  if (!schema?.properties) return t;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !FILE_PARAMETERS.includes(k)));
  return { ...t, inputSchema: jsonSchema({ ...schema, properties, required: (schema.required ?? []).filter((r) => !FILE_PARAMETERS.includes(r)) }) } as Tool;
}

export async function openBrowser(opts: {
  allowedOrigins: string[];
  httpCredentials?: { username: string; password: string };
  extraHeaders?: Record<string, string>;
  secretHeaders?: Record<string, string>;
  storageState?: string;
  outputDir: string;
  scrubber: SecretScrubber;
  onBlocked: (url: string) => void;
  headless?: boolean;
  survivesSignals?: boolean;
}): Promise<Browser> {
  const allowed = new Set(opts.allowedOrigins.map((o) => new URL(o).origin));
  const isAllowed = (url: string) => {
    const origin = originOf(url.replace(/^ws(s?):/, "http$1:"));
    return origin !== null && allowed.has(origin);
  };
  const reportedOrigins = new Set<string>();
  const report = (url: string) => {
    const key = originOf(url.replace(/^ws(s?):/, "http$1:")) ?? url;
    if (reportedOrigins.has(key)) return;
    reportedOrigins.add(key);
    opts.onBlocked(url);
  };
  let blockedNavigation: string | null = null;

  const chrome = await chromium.launch({ headless: opts.headless ?? true, handleSIGTERM: !opts.survivesSignals, handleSIGINT: !opts.survivesSignals, handleSIGHUP: !opts.survivesSignals });
  let disconnected = false;
  chrome.on("disconnected", () => (disconnected = true));
  try {
    const context = await chrome.newContext({
      httpCredentials: opts.httpCredentials,
      extraHTTPHeaders: { ...opts.extraHeaders, ...opts.secretHeaders },
      storageState: opts.storageState,
      serviceWorkers: "block",
    });
    const block = (route: Route, url: string) => {
      report(url);
      if (route.request().isNavigationRequest() && route.request().frame().parentFrame() === null) blockedNavigation = url;
      return route.abort("blockedbyclient");
    };
    await context.addInitScript(STRIP_SPECULATION);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (!isAllowed(url)) return block(route, url);
      try {
        if (!request.isNavigationRequest()) return await route.continue();
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers()["location"];
        if (response.status() >= 300 && response.status() < 400 && location) {
          const next = new URL(location, url).href;
          if (!isAllowed(next)) return block(route, next);
        }
        const headers = Object.fromEntries(Object.entries(response.headers()).filter(([k]) => k.toLowerCase() !== "speculation-rules"));
        return await route.fulfill({ response, headers });
      } catch {
        return route.abort("failed").catch(() => undefined);
      }
    });
    await context.routeWebSocket(/.*/, (ws) => {
      if (isAllowed(ws.url())) return ws.connectToServer();
      report(ws.url());
      return ws.close();
    });

    const server = await createConnection({ snapshot: { mode: "none" }, codegen: "none", outputDir: opts.outputDir }, async () => context);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const mcp = await createMCPClient({ transport: clientT });
    const all = await mcp.tools();

    const evaluate = all.browser_evaluate?.execute;
    const type = all.browser_type!.execute!;
    if (!evaluate) throw new Error("Playwright MCP no longer provides browser_evaluate");
    const fieldState = `(el) => (${fieldStateOf.toString()})(el, ${JSON.stringify(SECRET_MARK)})`;
    const refused = (text: string) => ({ content: [{ type: "text", text: `### Error\n${text}` }], isError: true });
    const probe = async (args: Record<string, unknown>) => evaluatedValue((await evaluate(args, internalCall)) as McpResult);

    const typedSecrets = new Set<string>();
    const typedPasswords = new Set<string>();
    const holdsSecret = (value: string) => [...typedSecrets].some((secret) => value.includes(secret));
    let dialogOpen = false;
    context.on("page", (page) => {
      page.on("dialog", () => (dialogOpen = true));
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) dialogOpen = false;
      });
    });
    let filled: ElementHandle[] = [];
    const lastValues = new WeakMap<ElementHandle, string>();
    const liveFilled = async () => {
      const alive = await Promise.all(filled.map((h) => within(h.evaluate(() => true).catch(() => false), HANDLE_READ_MS, true)));
      filled = filled.filter((_, i) => alive[i]);
      return filled;
    };
    const readValue = async (h: ElementHandle) => {
      if (dialogOpen) return lastValues.get(h) ?? "";
      const read = h.evaluate((el: any) => String(el.value ?? "")).then((value) => (lastValues.set(h, value), value));
      return within(read.catch(() => lastValues.get(h) ?? ""), HANDLE_READ_MS, lastValues.get(h) ?? "");
    };
    const keepSecret = (value: string) => {
      typedSecrets.add(value);
      opts.scrubber.add(value);
    };
    const scrubWithFilledValues = async <T>(result: T): Promise<T> => {
      for (const h of await liveFilled()) {
        const value = await readValue(h);
        if (value.length >= MIN_SECRET_LENGTH && [...typedPasswords].some((typed) => keptFrom(value, typed) || keptFrom(typed, value))) keepSecret(value);
      }
      return opts.scrubber.scrub(result);
    };
    const focusCheck = async () => {
      const held = await liveFilled();
      for (const page of context.pages()) {
        if (await focusIsOnSecretIn(page.mainFrame(), held, holdsSecret).catch(() => true)) return true;
      }
      return false;
    };
    const focusIsOnSecret = async () => {
      const verdict = await Promise.race([focusCheck(), new Promise<"slow">((r) => setTimeout(() => r("slow"), FOCUS_CHECK_MS))]);
      if (verdict !== "slow") return verdict;
      return !dialogOpen;
    };
    const findMarked = async (mark: string) => {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          const found = await frame.$(`[${SECRET_MARK}="${mark}"]`).catch(() => null);
          if (found) return found;
        }
      }
      return null;
    };

    const tools: ToolSet = {};
    for (const name of BROWSER_TOOLS) {
      const t = all[name];
      if (!t?.execute) throw new Error(`Playwright MCP no longer provides ${name}`);
      const execute = t.execute;
      tools[name] = {
        ...withoutFileParameters(t),
        execute: async (input, options) => {
          if (disconnected) throw new Error("the browser has closed");
          const safeInput = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([k]) => !FILE_PARAMETERS.includes(k)));
          if (name === "browser_press_key" && !KEYS_SAFE_ON_SECRETS.has(String(safeInput.key)) && (await focusIsOnSecret())) {
            return refused("Keys cannot be pressed while a password field has focus. Click somewhere else first.");
          }
          if (EDITS_FIELDS.has(name) && typeof safeInput.target === "string") {
            const field = (await probe({ element: "field", target: safeInput.target, function: fieldState })) as Partial<FieldState> | undefined;
            if (field?.marked === true || (typeof field?.value === "string" && holdsSecret(field.value))) return refused("Password fields can only be filled with sign_in or type_own_password.");
          }
          if (name === "browser_navigate") {
            const url = typeof safeInput.url === "string" ? safeInput.url : "";
            if (!/^https?:\/\//i.test(url) || !isAllowed(url)) {
              return { content: [{ type: "text", text: `### Error\nOnly http(s) addresses on the allowed origins can be opened: ${[...allowed].join(", ")}` }], isError: true };
            }
          }
          blockedNavigation = null;
          let result = (await execute(safeInput, options)) as McpResult;
          if (name === "browser_navigate" && result?.isError && INTERRUPTED.test(textOf(result))) result = (await execute(safeInput, options)) as McpResult;
          if (result?.isError && CLOSED.test(textOf(result))) throw new Error("the browser has closed");
          if (name === "browser_handle_dialog" && !result?.isError) dialogOpen = false;
          if (!result?.isError && !textOf(result).trim()) result.content = [{ type: "text", text: "Done. Call browser_snapshot to see the page." }];
          if (blockedNavigation) {
            result.content = [...(result.content ?? []), { type: "text", text: `### Blocked\n${blockedNavigation} is outside the allowed origins, so the browser did not open it. Go back or navigate to an allowed page.` }];
          }
          return scrubWithFilledValues(result);
        },
      };
    }

    return {
      tools,
      async fillField(ref, text, kind) {
        if (kind === "password") {
          const mark = randomUUID();
          const raw = (await evaluate(
            { element: "credential field", target: ref, function: `(el) => ({ type: el instanceof HTMLInputElement ? el.type : null, maxLength: el instanceof HTMLInputElement ? el.maxLength : null, origin: location.origin, marked: el instanceof HTMLInputElement && el.type === "password" && (el.setAttribute("${SECRET_MARK}", "${mark}"), true) })` },
            internalCall,
          )) as McpResult;
          if (raw?.isError) return `failed: ${opts.scrubber.scrub(textOf(raw))}`;
          const probe = evaluatedValue(raw) as { type?: unknown; maxLength?: unknown; origin?: unknown } | undefined;
          if (typeof probe?.origin !== "string" || !isAllowed(probe.origin)) return "failed: the page is not an allowed origin, so the password was not typed";
          if (probe.type !== "password") return "failed: the target is not a password field, so the password was not typed";
          const limit = typeof probe.maxLength === "number" && probe.maxLength >= 0 ? probe.maxLength : undefined;
          if (limit !== undefined && limit < MIN_SECRET_LENGTH) return `failed: the field takes at most ${limit} characters, too few to keep a password hidden, so nothing was typed`;
          if (limit !== undefined && limit < text.length) keepSecret(text.slice(0, limit));
          const field = await findMarked(mark);
          if (!field) return "failed: the password field could not be found again, so the password was not typed";
          filled = [...filled, field].slice(-MAX_HELD_FIELDS);
        }
        const out = (await type({ target: ref, element: kind === "password" ? "password field" : "username field", text }, internalCall)) as McpResult;
        if (kind === "password") {
          typedSecrets.add(text);
          typedPasswords.add(text);
          const held = filled.at(-1);
          if (held) {
            lastValues.set(held, text);
            const kept = await within(held.evaluate((el: any) => String(el.value ?? "")).catch(() => null), FOCUS_CHECK_MS, text);
            if (kept === null) return out?.isError ? `failed: ${opts.scrubber.scrub(textOf(out))}` : "failed: the page moved on before the field could be checked, so it is not known what the field kept";
            lastValues.set(held, kept);
            const shortened = kept !== text && kept.length > 0 && keptFrom(kept, text);
            if (shortened && kept.length >= MIN_SECRET_LENGTH) {
              keepSecret(kept);
            } else if (shortened) {
              await type({ target: ref, element: "password field", text: "" }, internalCall);
              const left = await within(held.evaluate((el: any) => String(el.value ?? "")).catch(() => null), HANDLE_READ_MS, null);
              return left === "" ? "failed: the field kept too little of the password to hide it, so it was cleared" : "failed: the field kept too little of the password to hide it, and it could not be cleared";
            } else if (!kept && !out?.isError) {
              return "failed: the field did not keep the password";
            }
          }
        }
        if (out?.isError) return `failed: ${opts.scrubber.scrub(textOf(out))}`;
        return kind === "password" ? "typed the password" : "typed the username";
      },
      async close() {
        try {
          await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
          await mcp.close();
        } finally {
          await chrome.close();
        }
      },
    };
  } catch (err) {
    await chrome.close();
    throw err;
  }
}
