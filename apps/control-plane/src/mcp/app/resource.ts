import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { RUN_REPORT_HTML } from "./run-report.generated.ts";

export const RUN_REPORT_URI = "ui://trawler/run-report";

export const RUN_REPORT_META = { ui: { resourceUri: RUN_REPORT_URI }, "ui/resourceUri": RUN_REPORT_URI };

const UI = { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true };

export function registerRunReportResource(server: McpServer): void {
  registerAppResource(server, "Trawler run report", RUN_REPORT_URI, { description: "An interactive report of one Trawler run, or of two runs compared.", _meta: { ui: UI } }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: RUN_REPORT_HTML, _meta: { ui: UI } }],
  }));
}
