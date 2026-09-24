import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { databaseUrl, onServer } from "../src/db/test-db.ts";

const name = `trawler_codegen_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const root = fileURLToPath(new URL("../../..", import.meta.url));
await onServer((c) => c.query(`CREATE DATABASE ${name}`));
try {
  execFileSync("docker", ["compose", "run", "--rm", "-e", `FLYWAY_URL=jdbc:postgresql://postgres:5432/${name}`, "flyway", "migrate", "-q"], { cwd: root, stdio: "inherit" });
  execFileSync("npx", ["kysely-codegen", "--dialect", "postgres", "--url", databaseUrl(name), "--exclude-pattern", "flyway_schema_history", "--out-file", "apps/control-plane/src/db/types.ts"], { cwd: root, stdio: "inherit" });
} finally {
  await onServer((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}
