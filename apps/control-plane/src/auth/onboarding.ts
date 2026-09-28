import { randomBytes } from "node:crypto";

export interface Invitation {
  id: string;
  organizationId: string;
  role: string;
}

export interface OnboardingStore {
  organizationsOf(userId: string): Promise<string[]>;
  hasOpenInvitation(email: string): Promise<boolean>;
  openInvitation(id: string, email: string): Promise<Invitation | null>;
  acceptInvitation(invitation: Invitation, userId: string): Promise<boolean>;
  declineInvitations(email: string): Promise<void>;
  createOrganization(name: string, slug: string, userId: string): Promise<string | null>;
}

export interface NewUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export type WorkspaceChoice = { join: string } | "own";

function slug(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
}

export function orgSlugFor(user: { email: string; name: string }): string {
  const base = slug(user.email.split("@")[0] ?? "") || slug(user.name) || "my";
  return `${base}-org`;
}

const normalisedEmail = (user: NewUser) => user.email.trim().toLowerCase();

export async function onboard(store: OnboardingStore, user: NewUser): Promise<string | null> {
  const [existing] = await store.organizationsOf(user.id);
  if (existing) return existing;
  if (user.emailVerified && (await store.hasOpenInvitation(normalisedEmail(user)))) return null;
  return createOwnOrganization(store, user);
}

export async function chooseWorkspace(store: OnboardingStore, user: NewUser, choice: WorkspaceChoice): Promise<string | null> {
  const [existing] = await store.organizationsOf(user.id);
  if (existing) return existing;
  if (choice === "own") {
    const created = await createOwnOrganization(store, user);
    if (user.emailVerified) await store.declineInvitations(normalisedEmail(user));
    return created;
  }
  if (!user.emailVerified) return null;
  const invitation = await store.openInvitation(choice.join, normalisedEmail(user));
  return invitation && (await store.acceptInvitation(invitation, user.id)) ? invitation.organizationId : null;
}

async function createOwnOrganization(store: OnboardingStore, user: NewUser): Promise<string> {
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
