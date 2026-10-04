import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { chooseWorkspace, onboard, type OnboardingStore, type WorkspaceChoice } from "./onboarding.ts";
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
  invitation: { id: string; organizationId: string; email: string; role: string | null; status: string; expiresAt: Date; createdAt: Date; inviterId: string };
  organization: { id: string; name: string; slug: string; createdAt: Date };
  user: { id: string; email: string; emailVerified: boolean; name: string };
  session: { id: string; userId: string; activeOrganizationId: string | null };
};

export function authPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, options: "-c role=trawler_auth" });
}

const CLOSED_ORGANIZATION_PATHS = [
  "get-organization",
  "get-full-organization",
  "check-slug",
  "set-active",
  "invite-member",
  "cancel-invitation",
  "accept-invitation",
  "reject-invitation",
  "get-invitation",
  "list-invitations",
  "list-user-invitations",
  "remove-member",
  "update-member-role",
  "leave",
];

export function createAuth(options: AuthOptions) {
  const db = new Kysely<AuthTables>({ dialect: new PostgresDialect({ pool: options.pool }) });
  const storeFor = (ex: Kysely<AuthTables> | Transaction<AuthTables>): OnboardingStore => ({
    organizationsOf: async (userId) =>
      (await ex.selectFrom("member").select("organizationId").where("userId", "=", userId).orderBy("createdAt").limit(1).execute()).map((m) => m.organizationId),
    hasOpenInvitation: async (email) =>
      !!(await ex.selectFrom("invitation").select("id").where(sql<string>`lower(email)`, "=", email).where("status", "=", "pending").where("expiresAt", ">", new Date()).executeTakeFirst()),
    openInvitation: async (id, email) => {
      const row = await ex
        .selectFrom("invitation")
        .select(["id", "organizationId", "role"])
        .where("id", "=", id)
        .where(sql<string>`lower(email)`, "=", email)
        .where("status", "=", "pending")
        .where("expiresAt", ">", new Date())
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
      await ex
        .updateTable("invitation")
        .set({ status: "canceled" })
        .where("status", "=", "pending")
        .where(sql<boolean>`lower(email) = (select lower(email) from invitation where id = ${invitation.id})`)
        .execute();
      return true;
    },
    declineInvitations: async (email) => {
      await ex.updateTable("invitation").set({ status: "rejected" }).where(sql<string>`lower(email)`, "=", email).where("status", "=", "pending").execute();
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
  const serialisedFor = <T>(userId: string, work: (store: OnboardingStore, tx: Transaction<AuthTables>) => Promise<T>) =>
    db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`onboard:${userId}`}, 0))`.execute(tx);
      return work(storeFor(tx), tx);
    });
  const onboardSerialised = async (user: AuthTables["user"]) => {
    const [existing] = await storeFor(db).organizationsOf(user.id);
    if (existing) return existing;
    return serialisedFor(user.id, (store) => onboard(store, user));
  };
  const chooseWorkspaceFor = async (session: { id: string; userId: string }, choice: WorkspaceChoice): Promise<string | null> => {
    const user = await db.selectFrom("user").selectAll().where("id", "=", session.userId).executeTakeFirstOrThrow();
    return serialisedFor(user.id, async (store, tx) => {
      const chosen = await chooseWorkspace(store, user, choice);
      if (chosen)
        await tx
          .updateTable("session")
          .set({ activeOrganizationId: chosen })
          .where("userId", "=", user.id)
          .where((eb) => eb.or([eb("id", "=", session.id), eb("activeOrganizationId", "is", null)]))
          .execute();
      return chosen;
    });
  };
  const invitationsFor = async (user: { email: string; emailVerified: boolean }): Promise<Array<{ id: string; orgName: string; role: string; inviterName: string; inviterEmail: string; inviterEmailVerified: boolean; expiresAt: Date }>> =>
    user.emailVerified
      ? (
          await db
            .selectFrom("invitation")
            .innerJoin("organization", "organization.id", "invitation.organizationId")
            .innerJoin("user as inviter", "inviter.id", "invitation.inviterId")
            .select(["invitation.id", "organization.name as orgName", "invitation.role", "inviter.name as inviterName", "inviter.email as inviterEmail", "inviter.emailVerified as inviterEmailVerified", "invitation.expiresAt"])
            .where(sql<string>`lower(invitation.email)`, "=", user.email.trim().toLowerCase())
            .where("invitation.status", "=", "pending")
            .where("invitation.expiresAt", ">", new Date())
            .orderBy("invitation.createdAt")
            .orderBy("invitation.id")
            .execute()
        ).map((row) => ({ ...row, role: row.role ?? "member" }))
      : [];
  const workspaceOf = async (session: { id: string; userId: string; activeOrganizationId?: string | null }): Promise<{ orgId: string; orgName: string; role: string } | "choosing" | null> => {
    const membership = session.activeOrganizationId
      ? await db
          .selectFrom("member")
          .innerJoin("organization", "organization.id", "member.organizationId")
          .select(["organization.id as orgId", "organization.name as orgName", "member.role"])
          .where("member.organizationId", "=", session.activeOrganizationId)
          .where("member.userId", "=", session.userId)
          .executeTakeFirst()
      : undefined;
    if (membership) return membership;
    if (!session.activeOrganizationId) {
      if (!(await storeFor(db).organizationsOf(session.userId)).length) return "choosing";
      const stored = await db.selectFrom("session").select("activeOrganizationId").where("id", "=", session.id).executeTakeFirst();
      if (stored?.activeOrganizationId) return workspaceOf({ ...session, activeOrganizationId: stored.activeOrganizationId });
    }
    await db.deleteFrom("session").where("id", "=", session.id).execute();
    return null;
  };
  const workspaceMembers = async (orgId: string): Promise<Array<{ id: string; userId: string; role: string; joinedAt: Date; name: string; email: string }>> =>
    db
      .selectFrom("member")
      .innerJoin("user", "user.id", "member.userId")
      .select(["member.id", "member.userId", "member.role", "member.createdAt as joinedAt", "user.name", "user.email"])
      .where("member.organizationId", "=", orgId)
      .orderBy("member.createdAt")
      .orderBy("member.id")
      .execute();
  const pendingInvitations = async (orgId: string): Promise<Array<{ id: string; email: string; role: string; expiresAt: Date; addressHasWorkspace: boolean }>> =>
    (
      await db
        .selectFrom("invitation")
        .select((eb) => [
          "invitation.id",
          "invitation.email",
          "invitation.role",
          "invitation.expiresAt",
          eb
            .exists(eb.selectFrom("user").innerJoin("member", "member.userId", "user.id").select("member.id").where("user.email", "=", sql<string>`lower(invitation.email)`))
            .as("addressHasWorkspace"),
        ])
        .where("organizationId", "=", orgId)
        .where("status", "=", "pending")
        .where("expiresAt", ">", new Date())
        .orderBy("expiresAt")
        .orderBy("id")
        .execute()
    ).map((row) => ({ ...row, role: row.role ?? "member", addressHasWorkspace: !!row.addressHasWorkspace }));
  const workspaceOfEmail = async (email: string): Promise<string | null> =>
    (
      await db
        .selectFrom("user")
        .innerJoin("member", "member.userId", "user.id")
        .select("member.organizationId")
        .where("user.email", "=", email)
        .orderBy("member.createdAt")
        .executeTakeFirst()
    )?.organizationId ?? null;
  const memberEmail = async (orgId: string, userId: string): Promise<string | null> => {
    const member = await db
      .selectFrom("member")
      .innerJoin("user", "user.id", "member.userId")
      .select("user.email")
      .where("member.organizationId", "=", orgId)
      .where("member.userId", "=", userId)
      .executeTakeFirst();
    return member?.email ?? null;
  };

  const auth = betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    database: options.pool,
    emailAndPassword: { enabled: false },
    advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      ...(options.github ? { github: { ...options.github, prompt: "select_account" as const } } : {}),
      ...(options.google ? { google: { ...options.google, prompt: "select_account" as const } } : {}),
    },
    plugins: [organizationPlugin(async (email) => (await workspaceOfEmail(email)) !== null), ...devSignIn(options.devOidc), nextCookies()],
    disabledPaths: CLOSED_ORGANIZATION_PATHS.map((path) => `/organization/${path}`),
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
  return Object.assign(auth, { workspaceOf, chooseWorkspace: chooseWorkspaceFor, invitationsFor, memberEmail, workspaceMembers, pendingInvitations });
}

export type Auth = ReturnType<typeof createAuth>;
