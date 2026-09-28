import { describe, expect, test } from "vitest";
import { chooseWorkspace, onboard, orgSlugFor, type OnboardingStore } from "./onboarding.ts";

function store(over: Partial<OnboardingStore> = {}) {
  const calls: string[] = [];
  const taken = new Set(["kwame-org"]);
  const s: OnboardingStore = {
    organizationsOf: async () => [],
    hasOpenInvitation: async () => false,
    openInvitation: async () => null,
    acceptInvitation: async (inv, userId) => (calls.push(`accept ${inv.id} for ${userId}`), true),
    declineInvitations: async (email) => { calls.push(`decline ${email}`); },
    createOrganization: async (name, slug, userId) => {
      if (taken.has(slug)) return null;
      calls.push(`create ${name} ${slug} for ${userId}`);
      return `org-${slug}`;
    },
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

  test("a verified email with an open invitation joins nothing yet and waits for a choice", async () => {
    const asked: string[] = [];
    const { s, calls } = store({ hasOpenInvitation: async (email) => (asked.push(email), true) });
    expect(await onboard(s, user)).toBeNull();
    expect(asked).toEqual(["ana.silva@acme.test"]);
    expect(calls).toEqual([]);
  });

  test("an unverified email never waits on an invitation and gets its own organisation", async () => {
    const { s, calls } = store({ hasOpenInvitation: async () => true });
    expect(await onboard(s, { ...user, emailVerified: false })).toBe("org-ana-silva-org");
    expect(calls).toEqual(["create ana-silva-org ana-silva-org for u1"]);
  });

  test("everyone else gets their own organisation, named after them, with a free slug", async () => {
    const { s, calls } = store();
    const org = await onboard(s, { ...user, id: "u2", email: "kwame@acme.test", name: "Kwame" });
    expect(org).toMatch(/^org-kwame-org-[a-z0-9]{1,6}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^create kwame-org kwame-org-[a-z0-9]{1,6} for u2$/);
  });
});

describe("chooseWorkspace", () => {
  const invitation = { id: "inv1", organizationId: "org-x", role: "admin" };

  test("joining accepts the chosen invitation, looked up by its id and the person's own address", async () => {
    const asked: string[] = [];
    const { s, calls } = store({ openInvitation: async (id, email) => (asked.push(`${id} ${email}`), id === "inv1" ? invitation : null) });
    expect(await chooseWorkspace(s, user, { join: "inv1" })).toBe("org-x");
    expect(asked).toEqual(["inv1 ana.silva@acme.test"]);
    expect(calls).toEqual(["accept inv1 for u1"]);
  });

  test("an invitation that is not open for this address joins nothing and creates nothing", async () => {
    const { s, calls } = store();
    expect(await chooseWorkspace(s, user, { join: "inv-other" })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("an invitation someone else claimed first joins nothing", async () => {
    const { s, calls } = store({ openInvitation: async () => invitation, acceptInvitation: async () => false });
    expect(await chooseWorkspace(s, user, { join: "inv1" })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("an unverified address cannot join by invitation", async () => {
    const { s, calls } = store({ openInvitation: async () => invitation });
    expect(await chooseWorkspace(s, { ...user, emailVerified: false }, { join: "inv1" })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("starting one's own creates the organisation and declines the invitations to that address", async () => {
    const { s, calls } = store();
    expect(await chooseWorkspace(s, user, "own")).toBe("org-ana-silva-org");
    expect(calls).toEqual(["create ana-silva-org ana-silva-org for u1", "decline ana.silva@acme.test"]);
  });

  test("an unverified address starting its own declines nobody's invitations", async () => {
    const { s, calls } = store();
    expect(await chooseWorkspace(s, { ...user, emailVerified: false }, "own")).toBe("org-ana-silva-org");
    expect(calls).toEqual(["create ana-silva-org ana-silva-org for u1"]);
  });

  test("someone who already chose keeps that organisation, whatever the second choice", async () => {
    const { s, calls } = store({ organizationsOf: async () => ["org-1"], openInvitation: async () => invitation });
    expect(await chooseWorkspace(s, user, { join: "inv1" })).toBe("org-1");
    expect(await chooseWorkspace(s, user, "own")).toBe("org-1");
    expect(calls).toEqual([]);
  });
});

describe("orgSlugFor", () => {
  test("keeps slugs short enough for a random suffix", () => {
    expect(orgSlugFor({ email: `${"a".repeat(80)}@x.test`, name: "" }).length).toBeLessThanOrEqual(34);
  });

  test("uses the email name, then the display name, then a fallback", () => {
    expect(orgSlugFor({ email: "ana.silva+test@acme.test", name: "x" })).toBe("ana-silva-test-org");
    expect(orgSlugFor({ email: "@@", name: "Zoë Adèle" })).toBe("zoe-adele-org");
    expect(orgSlugFor({ email: "", name: "李" })).toBe("my-org");
  });
});
