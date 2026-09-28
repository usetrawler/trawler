import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

type Invitation = { id: string; orgName: string; role: string; inviterName: string; inviterEmail: string; expiresAt: Date };
const newcomer = { userId: "u1", sessionId: "s1", name: "Ana", email: "ana@acme.test", emailVerified: true };
const state = vi.hoisted(() => ({ person: null as unknown, invitations: [] as Invitation[], askedFor: [] as unknown[] }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); }, unstable_isUnrecognizedActionError: () => false }));
vi.mock("../../server/auth.ts", () => ({
  signedInPerson: async () => state.person,
  getAuth: () => ({ invitationsFor: async (who: unknown) => { state.askedFor.push(who); return state.invitations; } }),
}));

const { default: WelcomePage } = await import("./page.tsx");
const invitation = (over: Partial<Invitation> = {}): Invitation => ({ id: "inv-1", orgName: "Acme Labs", role: "admin", inviterName: "Bo Chen", inviterEmail: "bo@acme.test", expiresAt: new Date(), ...over });
const html = async () => renderToStaticMarkup(await WelcomePage()).replaceAll("<!-- -->", "");

beforeEach(() => {
  state.person = { newcomer };
  state.invitations = [];
  state.askedFor = [];
});

test("a visitor who is not signed in goes to sign in", async () => {
  state.person = null;
  await expect(WelcomePage()).rejects.toMatchObject({ to: "/sign-in" });
});

test("a member who already has a workspace goes home", async () => {
  state.person = { member: { orgId: "org-1" } };
  await expect(WelcomePage()).rejects.toMatchObject({ to: "/" });
  expect(state.askedFor).toEqual([]);
});

test("an invitation shows the workspace, who invited and as what, with Join and the way to start one's own", async () => {
  state.invitations = [invitation()];
  const page = await html();
  expect(state.askedFor).toEqual([newcomer]);
  expect(page).toContain("You were invited to a workspace.");
  expect(page).toContain("Acme Labs");
  expect(page).toContain("Bo Chen (bo@acme.test) invited you as an admin.");
  expect(page).toMatch(/<input type="hidden" name="invitationId" value="inv-1"\/><button type="submit"[^>]*>Join<span class="sr-only"> Acme Labs<\/span>/);
  expect(page).toContain("Start my own workspace");
  expect(page).toContain("The invitation above is declined.");
  expect(page).toContain("shared with its owners and admins");
  expect(page).toContain("ana@acme.test");
});

test("several invitations are each shown with their own Join, and an inviter with no name by address", async () => {
  state.invitations = [invitation(), invitation({ id: "inv-2", orgName: "<b>Totally Legit</b>", role: "member", inviterName: " ", inviterEmail: "m@evil.test" })];
  const page = await html();
  expect(page).toContain("You were invited to 2 workspaces.");
  expect(page).toContain("The invitations above are declined.");
  expect(page).toContain("m@evil.test invited you as a member.");
  expect(page).toContain("&lt;b&gt;Totally Legit&lt;/b&gt;");
  expect(page).not.toContain("<b>Totally Legit</b>");
  expect(page.match(/name="invitationId"/g)).toHaveLength(2);
  expect(page).toContain('value="inv-2"');
});

test("with no invitation left open, the page says so and offers only a workspace of one's own", async () => {
  const page = await html();
  expect(page).toContain("Your invitation is no longer open.");
  expect(page).not.toContain("invitationId");
  expect(page).toContain("Start my own workspace");
});
