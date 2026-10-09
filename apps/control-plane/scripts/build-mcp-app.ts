import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRunReportModule } from "./mcp-app-build.ts";

writeFileSync(fileURLToPath(new URL("../src/mcp/app/run-report.generated.ts", import.meta.url)), await buildRunReportModule());
