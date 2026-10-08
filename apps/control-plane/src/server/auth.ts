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
      mcp: env.mcp,
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
  name: string;
  email: string;
  orgId: string;
  orgName: string;
  role: string;
}

export interface Newcomer {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

export async function signedInPerson(requestHeaders: Headers): Promise<{ member: Member } | { newcomer: Newcomer } | null> {
  const auth = getAuth();
  const found = await auth.api.getSession({ headers: requestHeaders });
  if (!found) return null;
  const workspace = await auth.workspaceOf(found.session);
  if (workspace === "choosing") return { newcomer: { userId: found.user.id, sessionId: found.session.id, name: found.user.name, email: found.user.email, emailVerified: found.user.emailVerified } };
  return workspace ? { member: { userId: found.user.id, name: found.user.name, email: found.user.email, ...workspace } } : null;
}

export async function signedInMember(requestHeaders: Headers): Promise<Member | null> {
  const person = await signedInPerson(requestHeaders);
  return person && "member" in person ? person.member : null;
}

export function canManageBilling(member: Member): boolean {
  return member.role.split(",").some((role) => role.trim() === "owner" || role.trim() === "admin");
}
