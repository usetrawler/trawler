import { createMCPClient } from "@ai-sdk/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnection } from "@playwright/mcp";
import { chromium, type ElementHandle, type Frame, type Route } from "playwright";
import { jsonSchema, type Tool, type ToolSet } from "ai";
import type { SecretScrubber } from "./secrets.ts";
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
const CLOSED = /Target page, context or browser has been closed|Browser has been closed/;
const INTERRUPTED = /is interrupted by another navigation/;
const DEEPEST_ACTIVE = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
})()`;

async function focusIsOnSecretIn(frame: Frame, depth = 0): Promise<boolean> {
  if (depth > 10) return true;
  const active = (await frame.evaluateHandle(DEEPEST_ACTIVE)).asElement() as ElementHandle | null;
  if (!active) return false;
  const secret = await active.evaluate(
    (el: any, mark: string) => el.getAttribute(mark) === "1" || (el.tagName === "INPUT" && String(el.type).toLowerCase() === "password"),
    SECRET_MARK,
  );
  if (secret) return true;
  for (const child of frame.childFrames()) {
    const owner = await child.frameElement().catch(() => null);
    if (owner && (await owner.evaluate((a: unknown, b: unknown) => a === b, active))) return focusIsOnSecretIn(child, depth + 1);
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

  const chrome = await chromium.launch({ headless: opts.headless ?? true });
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
    const isSecretField = `(el) => !!el && (el.getAttribute?.("${SECRET_MARK}") === "1" || (el instanceof HTMLInputElement && el.type === "password"))`;
    const refused = (text: string) => ({ content: [{ type: "text", text: `### Error\n${text}` }], isError: true });
    const probe = async (args: Record<string, unknown>) => evaluatedValue((await evaluate(args, internalCall)) as McpResult);

    const focusIsOnSecret = async () => {
      for (const page of context.pages()) {
        if (await focusIsOnSecretIn(page.mainFrame()).catch(() => true)) return true;
      }
      return false;
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
          if (name === "browser_press_key" && (await focusIsOnSecret())) {
            return refused("Keys cannot be pressed while a password field has focus. Click somewhere else first.");
          }
          if (EDITS_FIELDS.has(name) && typeof safeInput.target === "string" && (await probe({ element: "field", target: safeInput.target, function: isSecretField })) === true) {
            return refused("Password fields can only be filled with sign_in.");
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
          if (!result?.isError && !textOf(result).trim()) result.content = [{ type: "text", text: "Done. Call browser_snapshot to see the page." }];
          if (blockedNavigation) {
            result.content = [...(result.content ?? []), { type: "text", text: `### Blocked\n${blockedNavigation} is outside the allowed origins, so the browser did not open it. Go back or navigate to an allowed page.` }];
          }
          return opts.scrubber.scrub(result);
        },
      };
    }

    return {
      tools,
      async fillField(ref, text, kind) {
        if (kind === "password") {
          const raw = (await evaluate(
            { element: "credential field", target: ref, function: `(el) => ({ type: el instanceof HTMLInputElement ? el.type : null, origin: location.origin, marked: (el.setAttribute("${SECRET_MARK}", "1"), true) })` },
            internalCall,
          )) as McpResult;
          if (raw?.isError) return `failed: ${opts.scrubber.scrub(textOf(raw))}`;
          const probe = evaluatedValue(raw) as { type?: unknown; origin?: unknown } | undefined;
          if (typeof probe?.origin !== "string" || !isAllowed(probe.origin)) return "failed: the page is not an allowed origin, so the password was not typed";
          if (probe.type !== "password") return "failed: the target is not a password field, so the password was not typed";
        }
        const out = (await type({ target: ref, element: kind === "password" ? "password field" : "username field", text }, internalCall)) as McpResult;
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
