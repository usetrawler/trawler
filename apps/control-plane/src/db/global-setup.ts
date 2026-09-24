import { execFileSync } from "node:child_process";
import { TEMPLATE_DATABASE, onServer } from "./test-db.ts";

export default async function setup(): Promise<void> {
  await onServer(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  }).catch((err: unknown) => {
    throw new Error(`the test database server is not reachable; run \`npm run db:up\` first (${err instanceof Error ? err.message : String(err)})`);
  });
  execFileSync("docker", ["compose", "run", "--rm", "-e", `FLYWAY_URL=jdbc:postgresql://postgres:5432/${TEMPLATE_DATABASE}`, "flyway", "migrate", "-q"], { stdio: "inherit" });
}
