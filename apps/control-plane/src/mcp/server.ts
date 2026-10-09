import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import type { RunApiDeps } from "../run-api/service.ts";
import { registerRunReportResource } from "./app/resource.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerReadTools, type Caller, type ToolDeps } from "./tools.ts";
import { UNTRUSTED_NOTICE } from "./untrusted.ts";

const INSTRUCTIONS = `Trawler tests a web product with AI people and reports defects. Start with whoami, then list_projects and list_runs; read a run with get_run and a finding with get_finding. ${UNTRUSTED_NOTICE}`;

export function callerOf(authInfo: AuthInfo | undefined): Caller {
  const extra = authInfo?.extra as Record<string, unknown> | undefined;
  const text = (key: string) => {
    const value = extra?.[key];
    if (typeof value !== "string" || !value) throw new Error(`the MCP connection has no ${key}`);
    return value;
  };
  return {
    grantId: text("grantId"), userId: text("userId"), orgId: text("workspaceId"), role: text("role"), clientId: authInfo!.clientId, scopes: authInfo!.scopes,
    projectId: typeof extra?.projectId === "string" ? extra.projectId : null,
  };
}

export function createMcpEndpoint(deps: Omit<ToolDeps, "caller"> & { runApi: () => RunApiDeps }) {
  return createMcpHandler((context) => {
    const server = new McpServer({ name: "Trawler", version: "1.0.0" }, { instructions: INSTRUCTIONS });
    const tools = { ...deps, caller: callerOf(context.authInfo) };
    registerReadTools(server, tools);
    registerRunTools(server, tools);
    registerRunReportResource(server);
    return server;
  }, { legacy: "stateless", maxRequestBodySize: 64 * 1024 });
}
