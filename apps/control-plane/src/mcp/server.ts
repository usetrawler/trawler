import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const mcpHandler = createMcpHandler((context) => {
  const server = new McpServer({ name: "Trawler", version: "1.0.0" });
  server.registerTool("connection_status", {
    description: "Check the authenticated Trawler connection and its granted scopes.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => ({ content: [{ type: "text", text: JSON.stringify(context.authInfo?.extra) }] }));
  return server;
}, { legacy: "stateless", maxRequestBodySize: 64 * 1024 });
