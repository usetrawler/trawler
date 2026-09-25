import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { onboard, type OnboardingStore } from "./onboarding.ts";
import { devSignIn, organizationPlugin } from "./plugins.ts";
import { logError } from "../server/log.ts";

export interface AuthOptions {
  pool: pg.Pool;
  secret: string;
  baseURL: string;
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
  devOidc?: { issuer: string; clientId: string; clientSecret: string };
}

type AuthTables = {
  member: { id: string; organizationId: string; userId: string; role: string; createdAt: Date };
  invitation: { id: string; organizationId: string; email: string; role: string | null; status: string; expiresAt: Date };
  organization: { id: string; name: string; slug: string; createdAt: Date };
  user: { id: string; email: string; emailVerified: boolean; name: string };
};

export function authPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, options: "-c role=trawler_auth" });
}

export function createAuth(options: AuthOptions) {
  const db = new Kysely<AuthTables>({ dialect: new PostgresDialect({ pool: options.pool }) });
  const storeFor = (ex: Kysely<AuthTables> | Transaction<AuthTables>): OnboardingStore => ({
    organizationsOf: async (userId) =>
      (await ex.selectFrom("member").select("organizationId").where("userId", "=", userId).orderBy("createdAt").limit(1).execute()).map((m) => m.organizationId),
    pendingInvitation: async (email) => {
      const row = await ex
        .selectFrom("invitation")
        .select(["id", "organizationId", "role"])
        .where(sql<string>`lower(email)`, "=", email)
        .where("status", "=", "pending")
        .where("expiresAt", ">", new Date())
        .orderBy("expiresAt", "desc")
        .executeTakeFirst();
      return row ? { id: row.id, organizationId: row.organizationId, role: row.role ?? "member" } : null;
    },
    acceptInvitation: async (invitation, userId) => {
      const claimed = await ex
        .updateTable("invitation")
        .set({ status: "accepted" })
        .where("id", "=", invitation.id)
        .where("status", "=", "pending")
        .where("expiresAt", ">", new Date())
        .returning("id")
        .executeTakeFirst();
      if (!claimed) return false;
      await ex
        .insertInto("member")
        .values({ id: crypto.randomUUID(), organizationId: invitation.organizationId, userId, role: invitation.role, createdAt: new Date() })
        .onConflict((oc) => oc.columns(["organizationId", "userId"]).doNothing())
        .execute();
      return true;
    },
    createOrganization: async (name, slug, userId) => {
      const org = await ex
        .insertInto("organization")
        .values({ id: crypto.randomUUID(), name, slug, createdAt: new Date() })
        .onConflict((oc) => oc.column("slug").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!org) return null;
      await ex.insertInto("member").values({ id: crypto.randomUUID(), organizationId: org.id, userId, role: "owner", createdAt: new Date() }).execute();
      return org.id;
    },
  });
  const onboardSerialised = async (user: AuthTables["user"]) => {
    const [existing] = await storeFor(db).organizationsOf(user.id);
    if (existing) return existing;
    return db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`onboard:${user.id}`}, 0))`.execute(tx);
      return onboard(storeFor(tx), user);
    });
  };

  const auth = betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    database: options.pool,
    emailAndPassword: { enabled: false },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      ...(options.github ? { github: options.github } : {}),
      ...(options.google ? { google: options.google } : {}),
    },
    plugins: [organizationPlugin(), ...devSignIn(options.devOidc), nextCookies()],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            try {
              const user = await db.selectFrom("user").selectAll().where("id", "=", session.userId).executeTakeFirstOrThrow();
              return { data: { ...session, activeOrganizationId: await onboardSerialised(user) } };
            } catch (err) {
              await logError("workspace setup failed", { err, code: (err as { code?: unknown }).code });
              throw new APIError("INTERNAL_SERVER_ERROR", { code: "WORKSPACE_SETUP_FAILED", message: "workspace_setup_failed" });
            }
          },
        },
      },
    },
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
