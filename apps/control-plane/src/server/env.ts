import type { ArtifactStorage } from "../artifacts/store.ts";

export interface ServerEnv {
  databaseUrl: string;
  authSecret: string;
  baseURL: string;
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  devOidc?: { issuer: string; clientId: string; clientSecret: string };
  setup?: { apiKey: string; model: string };
  runnerToken?: string;
  smokeToken?: string;
  openRouterUrl: string;
  betaEmails?: string[];
  artifacts?: ArtifactStorage;
}

export const DEFAULT_SETUP_MODEL = "deepseek/deepseek-v4.1-flash";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

function pair(id: string | undefined, secret: string | undefined) {
  return id && secret ? { clientId: id, clientSecret: secret } : undefined;
}

export function readEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const missing = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  if ((env.BETTER_AUTH_SECRET ?? "").length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  if (env.NODE_ENV === "production" && !env.BETTER_AUTH_URL!.startsWith("https://")) throw new Error("BETTER_AUTH_URL must use https in production");
  const devIssuer = env.TRAWLER_DEV_OIDC_ISSUER;
  const openRouterUrl = (env.TRAWLER_OPENROUTER_URL ?? OPENROUTER_URL).replace(/\/+$/, "");
  if (env.NODE_ENV === "production" && openRouterUrl !== OPENROUTER_URL) throw new Error("TRAWLER_OPENROUTER_URL can only be changed outside production");
  if (devIssuer && env.NODE_ENV === "production") throw new Error("TRAWLER_DEV_OIDC_ISSUER must never be set in production");
  return {
    databaseUrl: env.DATABASE_URL!,
    authSecret: env.BETTER_AUTH_SECRET!,
    baseURL: env.BETTER_AUTH_URL!,
    github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    devOidc: devIssuer ? { issuer: devIssuer, clientId: "trawler-dev", clientSecret: "trawler-dev-secret" } : undefined,
    runnerToken: bearerToken(env.TRAWLER_RUNNER_TOKEN, "TRAWLER_RUNNER_TOKEN"),
    smokeToken: bearerToken(env.TRAWLER_SMOKE_TOKEN, "TRAWLER_SMOKE_TOKEN"),
    openRouterUrl,
    betaEmails: env.TRAWLER_BETA_EMAILS?.trim() ? env.TRAWLER_BETA_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean) : undefined,
    setup: env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY, model: env.TRAWLER_SETUP_MODEL ?? DEFAULT_SETUP_MODEL } : undefined,
    artifacts: artifactStorage(env),
  };
}

const ARTIFACT_VARIABLES = {
  bucket: "TRAWLER_ARTIFACTS_BUCKET",
  endpoint: "TRAWLER_ARTIFACTS_ENDPOINT",
  region: "TRAWLER_ARTIFACTS_REGION",
  accessKeyId: "TRAWLER_ARTIFACTS_ACCESS_KEY_ID",
  secretAccessKey: "TRAWLER_ARTIFACTS_SECRET_ACCESS_KEY",
} as const;

export function artifactStorage(env: Record<string, string | undefined> = process.env): ArtifactStorage | undefined {
  const entries = Object.entries(ARTIFACT_VARIABLES).map(([field, name]) => [field, name, env[name]?.trim() ?? ""] as const);
  const missing = entries.filter(([, , value]) => !value).map(([, name]) => name);
  if (missing.length === entries.length) return undefined;
  if (missing.length > 0) throw new Error(`artifact storage also needs ${missing.join(", ")}`);
  const storage = Object.fromEntries(entries.map(([field, , value]) => [field, value])) as Omit<ArtifactStorage, "pathStyle">;
  if (!URL.canParse(storage.endpoint)) throw new Error("TRAWLER_ARTIFACTS_ENDPOINT must be a URL");
  if (env.NODE_ENV === "production" && new URL(storage.endpoint).protocol !== "https:") throw new Error("TRAWLER_ARTIFACTS_ENDPOINT must use https in production");
  return { ...storage, pathStyle: env.TRAWLER_ARTIFACTS_PATH_STYLE === "true" };
}

const BEARER_TOKEN = /^[A-Za-z0-9._~+\/=-]{32,512}$/;

function bearerToken(value: string | undefined, name: string): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (!BEARER_TOKEN.test(token)) throw new Error(`${name} must be 32 to 512 characters of letters, digits and ._~+/=-`);
  return token;
}
