import { createDb, type Database } from "../db/index.ts";
import { keyringFromEnv, type Keyring } from "../lib/secrets.ts";
import { readEnv } from "./env.ts";

let db: Database | undefined;
let keys: Keyring | undefined;

export function getDb(): Database {
  db ??= createDb(readEnv().databaseUrl);
  return db;
}

export function getKeyring(): Keyring {
  keys ??= keyringFromEnv();
  return keys;
}
