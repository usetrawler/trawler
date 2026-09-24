import { createMCPClient } from "@ai-sdk/mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnection } from "@playwright/mcp";
import { chromium } from "playwright";
import type { ToolSet } from "ai";
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
] as const;

export interface Browser {
  tools: ToolSet;
  fillField(ref: string, text: string, kind: FieldKind): Promise<string>;
  close(): Promise<void>;
}

const internalCall = { toolCallId: "internal", messages: [], context: {} };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
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
  const chrome = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const context = await chrome.newContext({
      httpCredentials: opts.httpCredentials,
      extraHTTPHeaders: { ...opts.extraHeaders, ...opts.secretHeaders },
      storageState: opts.storageState,
    });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      const origin = originOf(url);
      if (origin !== null && allowed.has(origin)) return route.continue();
      opts.onBlocked(url);
      return route.abort("blockedbyclient");
    });

    const server = await createConnection({ snapshot: { mode: "full" }, outputDir: opts.outputDir }, async () => context);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const mcp = await createMCPClient({ transport: clientT });
    const all = await mcp.tools();

    const tools: ToolSet = {};
    for (const name of BROWSER_TOOLS) {
      const t = all[name];
      if (!t?.execute) throw new Error(`Playwright MCP no longer provides ${name}`);
      const execute = t.execute;
      tools[name] = { ...t, execute: async (input, options) => opts.scrubber.scrub(await execute(input, options)) };
    }
    const evaluate = all.browser_evaluate?.execute;
    const type = all.browser_type!.execute!;
    if (!evaluate) throw new Error("Playwright MCP no longer provides browser_evaluate");

    return {
      tools,
      async fillField(ref, text, kind) {
        if (kind === "password") {
          const probe = evaluatedValue(
            await evaluate(
              { element: "credential field", target: ref, function: "(el) => ({ type: el instanceof HTMLInputElement ? el.type : null, origin: location.origin })" },
              internalCall,
            ),
          ) as { type?: unknown; origin?: unknown } | undefined;
          if (typeof probe?.origin !== "string" || !allowed.has(probe.origin)) return "failed: the page is not an allowed origin, so the password was not typed";
          if (probe.type !== "password") return "failed: the target is not a password field, so the password was not typed";
        }
        const out = await type({ target: ref, element: kind === "password" ? "password field" : "username field", text }, internalCall);
        const message = opts.scrubber.scrub(textOf(out));
        return (out as { isError?: boolean })?.isError ? `failed: ${message}` : message;
      },
      async close() {
        await mcp.close();
        await chrome.close();
      },
    };
  } catch (err) {
    await chrome.close();
    throw err;
  }
}
