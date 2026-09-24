import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Kysely, PostgresDialect, sql } from "kysely";
import type pg from "pg";
import { onboard, type OnboardingStore } from "./onboarding.ts";
import { authPlugins } from "./plugins.ts";

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
  organization: { id: string; slug: string };
  user: { id: string; email: string; emailVerified: boolean; name: string };
};

export function createAuth(options: AuthOptions) {
  const db = new Kysely<AuthTables>({ dialect: new PostgresDialect({ pool: options.pool }) });
  const store: OnboardingStore = {
    organizationsOf: async (userId) =>
      (await db.selectFrom("member").select("organizationId").where("userId", "=", userId).orderBy("createdAt").execute()).map((m) => m.organizationId),
    pendingInvitation: async (email) => {
      const row = await db
        .selectFrom("invitation")
        .select(["id", "organizationId", "role"])
        .where(sql`lower(email)`, "=", email)
        .where("status", "=", "pending")
        .where("expiresAt", ">", new Date())
        .orderBy("expiresAt", "desc")
        .executeTakeFirst();
      return row ? { id: row.id, organizationId: row.organizationId, role: row.role ?? "member" } : null;
    },
    acceptInvitation: async (invitation, userId) => {
      await db.transaction().execute(async (tx) => {
        await tx.insertInto("member").values({ id: crypto.randomUUID(), organizationId: invitation.organizationId, userId, role: invitation.role, createdAt: new Date() }).execute();
        await tx.updateTable("invitation").set({ status: "accepted" }).where("id", "=", invitation.id).execute();
      });
    },
    slugTaken: async (slug) => !!(await db.selectFrom("organization").select("id").where("slug", "=", slug).executeTakeFirst()),
    createOrganization: async (name, slug, userId) => {
      const org = await auth.api.createOrganization({ body: { name, slug, userId } });
      if (!org) throw new Error("the organisation could not be created");
      return org.id;
    },
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
    plugins: [...authPlugins(options.devOidc), nextCookies()],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await db.selectFrom("user").selectAll().where("id", "=", session.userId).executeTakeFirstOrThrow();
            return { data: { ...session, activeOrganizationId: await onboard(store, user) } };
          },
        },
      },
    },
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
