import { describe, expect, test } from "vitest";
import { onboard, orgSlugFor, type OnboardingStore } from "./onboarding.ts";

function store(over: Partial<OnboardingStore> = {}) {
  const calls: string[] = [];
  const taken = new Set(["kwame-org"]);
  const s: OnboardingStore = {
    organizationsOf: async () => [],
    pendingInvitation: async () => null,
    acceptInvitation: async (inv, userId) => void calls.push(`accept ${inv.id} for ${userId}`),
    slugTaken: async (slug) => taken.has(slug),
    createOrganization: async (name, slug, userId) => (calls.push(`create ${name} ${slug} for ${userId}`), `org-${slug}`),
    ...over,
  };
  return { s, calls };
}

const user = { id: "u1", email: "Ana.Silva@acme.test", emailVerified: true, name: "Ana Silva" };

describe("onboard", () => {
  test("a returning member keeps their first organisation", async () => {
    const { s, calls } = store({ organizationsOf: async () => ["org-1", "org-2"] });
    expect(await onboard(s, user)).toBe("org-1");
    expect(calls).toEqual([]);
  });

  test("a verified email with a pending invitation joins that organisation", async () => {
    const { s, calls } = store({ pendingInvitation: async (email) => (email === "ana.silva@acme.test" ? { id: "inv1", organizationId: "org-x", role: "member" } : null) });
    expect(await onboard(s, user)).toBe("org-x");
    expect(calls).toEqual(["accept inv1 for u1"]);
  });

  test("an unverified email never joins by invitation", async () => {
    const { s, calls } = store({ pendingInvitation: async () => ({ id: "inv1", organizationId: "org-x", role: "member" }) });
    expect(await onboard(s, { ...user, emailVerified: false })).toBe("org-ana-silva-org");
    expect(calls).toEqual(["create ana-silva-org ana-silva-org for u1"]);
  });

  test("everyone else gets their own organisation, named after them, with a free slug", async () => {
    const { s, calls } = store();
    expect(await onboard(s, { ...user, id: "u2", email: "kwame@acme.test", name: "Kwame" })).toBe("org-kwame-org-2");
    expect(calls).toEqual(["create kwame-org kwame-org-2 for u2"]);
  });
});

describe("orgSlugFor", () => {
  test("uses the email name, then the display name, then a fallback", () => {
    expect(orgSlugFor({ email: "ana.silva+test@acme.test", name: "x" })).toBe("ana-silva-test-org");
    expect(orgSlugFor({ email: "@@", name: "Zoë Łucja" })).toBe("zoe-ucja-org");
    expect(orgSlugFor({ email: "", name: "李" })).toBe("my-org");
  });
});
