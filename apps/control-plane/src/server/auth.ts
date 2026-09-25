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

export interface Member {
  userId: string;
  email: string;
  orgId: string;
}

export async function signedInMember(requestHeaders: Headers): Promise<Member | null> {
  const auth = getAuth();
  const found = await auth.api.getSession({ headers: requestHeaders });
  if (!found) return null;
  const orgId = await auth.workspaceOf(found.session);
  return orgId ? { userId: found.user.id, email: found.user.email, orgId } : null;
}

export async function canManageBilling(requestHeaders: Headers): Promise<boolean> {
  const member = await getAuth().api.getActiveMember({ headers: requestHeaders }).catch(() => null);
  return (member?.role ?? "").split(",").some((role) => role.trim() === "owner" || role.trim() === "admin");
}
