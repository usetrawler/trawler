export interface ServerEnv {
  databaseUrl: string;
  authSecret: string;
  baseURL: string;
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  devOidc?: { issuer: string; clientId: string; clientSecret: string };
  setup?: { apiKey: string; model: string };
  runnerToken?: string;
}

export const DEFAULT_SETUP_MODEL = "deepseek/deepseek-v4.1-flash";

function pair(id: string | undefined, secret: string | undefined) {
  return id && secret ? { clientId: id, clientSecret: secret } : undefined;
}

export function readEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const missing = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  if ((env.BETTER_AUTH_SECRET ?? "").length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  if (env.NODE_ENV === "production" && !env.BETTER_AUTH_URL!.startsWith("https://")) throw new Error("BETTER_AUTH_URL must use https in production");
  const devIssuer = env.TRAWLER_DEV_OIDC_ISSUER;
  if (devIssuer && env.NODE_ENV === "production") throw new Error("TRAWLER_DEV_OIDC_ISSUER must never be set in production");
  return {
    databaseUrl: env.DATABASE_URL!,
    authSecret: env.BETTER_AUTH_SECRET!,
    baseURL: env.BETTER_AUTH_URL!,
    github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    devOidc: devIssuer ? { issuer: devIssuer, clientId: "trawler-dev", clientSecret: "trawler-dev-secret" } : undefined,
    runnerToken: env.TRAWLER_RUNNER_TOKEN && env.TRAWLER_RUNNER_TOKEN.length >= 32 ? env.TRAWLER_RUNNER_TOKEN : undefined,
    setup: env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY, model: env.TRAWLER_SETUP_MODEL ?? DEFAULT_SETUP_MODEL } : undefined,
  };
}
