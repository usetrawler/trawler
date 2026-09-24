import { authPool, createAuth, type Auth } from "../auth/auth.ts";
import { readEnv } from "./env.ts";

let cached: Auth | undefined;

export function getAuth(): Auth {
  if (!cached) {
    const env = readEnv();
    cached = createAuth({
      pool: authPool(env.databaseUrl),
      secret: env.authSecret,
      baseURL: env.baseURL,
      github: env.github,
      google: env.google,
      devOidc: env.devOidc,
    });
  }
  return cached;
}

export function signInProviders(): Array<"github" | "google" | "dev"> {
  const env = readEnv();
  return [...(env.github ? (["github"] as const) : []), ...(env.google ? (["google"] as const) : []), ...(env.devOidc ? (["dev"] as const) : [])];
}
