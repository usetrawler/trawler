import { randomBytes } from "node:crypto";

export interface Invitation {
  id: string;
  organizationId: string;
  role: string;
}

export interface OnboardingStore {
  organizationsOf(userId: string): Promise<string[]>;
  pendingInvitation(email: string): Promise<Invitation | null>;
  acceptInvitation(invitation: Invitation, userId: string): Promise<boolean>;
  createOrganization(name: string, slug: string, userId: string): Promise<string | null>;
}

export interface NewUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
}

export function orgSlugFor(user: { email: string; name: string }): string {
  const base = slug(user.email.split("@")[0] ?? "") || slug(user.name) || "my";
  return `${base}-org`;
}

export async function onboard(store: OnboardingStore, user: NewUser): Promise<string> {
  const [existing] = await store.organizationsOf(user.id);
  if (existing) return existing;
  if (user.emailVerified) {
    const invitation = await store.pendingInvitation(user.email.trim().toLowerCase());
    if (invitation && (await store.acceptInvitation(invitation, user.id))) return invitation.organizationId;
  }
  const base = orgSlugFor(user);
  for (const candidate of [base, `${base}-${randomSuffix()}`, `${base}-${randomSuffix()}`, `${base}-${randomSuffix(12)}`]) {
    const created = await store.createOrganization(base, candidate, user.id);
    if (created) return created;
  }
  throw new Error("could not find a free workspace name");
}

function randomSuffix(length = 6): string {
  return randomBytes(length).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, length) || "x";
}
