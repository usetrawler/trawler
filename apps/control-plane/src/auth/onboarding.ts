export interface Invitation {
  id: string;
  organizationId: string;
  role: string;
}

export interface OnboardingStore {
  organizationsOf(userId: string): Promise<string[]>;
  pendingInvitation(email: string): Promise<Invitation | null>;
  acceptInvitation(invitation: Invitation, userId: string): Promise<void>;
  slugTaken(slug: string): Promise<boolean>;
  createOrganization(name: string, slug: string, userId: string): Promise<string>;
}

export interface NewUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
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
    if (invitation) {
      await store.acceptInvitation(invitation, user.id);
      return invitation.organizationId;
    }
  }
  const base = orgSlugFor(user);
  let candidate = base;
  for (let n = 2; await store.slugTaken(candidate); n++) candidate = `${base}-${n}`;
  return store.createOrganization(base, candidate, user.id);
}
