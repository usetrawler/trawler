import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { onServer } from "./test-db.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../../db/migrations");

function migrationsHash(): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(MIGRATIONS).sort()) hash.update(file).update("\0").update(readFileSync(join(MIGRATIONS, file))).update("\0");
  return hash.digest("hex").slice(0, 16);
}

export default async function setup(project: TestProject): Promise<void> {
  const template = `trawler_tpl_${migrationsHash()}`;
  const exists = await onServer(async (c) => (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [template])).rowCount === 1);
  if (!exists) {
    const staging = `${template}_${randomUUID().slice(0, 8)}`;
    await onServer((c) => c.query(`CREATE DATABASE ${staging}`));
    try {
      execFileSync("docker", ["compose", "run", "--rm", "-e", `FLYWAY_URL=jdbc:postgresql://postgres:5432/${staging}`, "flyway", "migrate", "-q"], { stdio: "inherit" });
      await onServer((c) => c.query(`ALTER DATABASE ${staging} RENAME TO ${template}`)).catch(async (err: unknown) => {
        if ((err as { code?: string }).code !== "42P04") throw err;
      });
    } finally {
      await onServer((c) => c.query(`DROP DATABASE IF EXISTS ${staging} WITH (FORCE)`));
    }
  }
  project.provide("testTemplate", template);
}
