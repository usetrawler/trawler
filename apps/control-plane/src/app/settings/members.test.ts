import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ actions: [] as Array<[unknown, boolean]>, states: [] as unknown[], flow: null as unknown }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (_action: unknown, initial: unknown) => {
    const [result, pending] = react.actions.shift() ?? [initial, false];
    return [result, () => {}, pending];
  },
  useReducer: (_reducer: unknown, initial: unknown) => [react.flow ?? initial, () => {}],
  useState: (initial: unknown) => [react.states.length ? react.states.shift() : initial, () => {}],
  useEffect: () => {},
}));
vi.mock("./actions.ts", () => ({ inviteMemberAction: async () => ({}), revokeInvitationAction: async () => ({}), removeMemberAction: async () => ({}), changeRoleAction: async () => ({}) }));

const { Members, invitedStatus, roleLabel } = await import("./members.tsx");
const members = [
  { id: "m-1", name: "Ana", email: "ana@acme.test", role: "owner", joinedAt: "2026-09-20T10:00:00.000Z", you: true },
  { id: "m-2", name: "Lee", email: "lee@acme.test", role: "member", joinedAt: "2026-09-21T10:00:00.000Z", you: false },
  { id: "m-3", name: "", email: "bo@acme.test", role: "admin", joinedAt: "2026-09-22T10:00:00.000Z", you: false },
  { id: "m-4", name: "Cy", email: "cy@acme.test", role: "owner", joinedAt: "2026-09-23T10:00:00.000Z", you: false },
];
const invitations = [{ id: "inv-1", email: "max@acme.test", role: "admin", expiresAt: "2026-10-03T10:00:00.000Z", addressHasWorkspace: false }];
const IDLE: [unknown, boolean] = [{}, false];
const BEFORE = {};
const render = (canManage = true, people = members) => renderToStaticMarkup(createElement(Members, { members: people, invitations, canManage, signInAt: "app.usetrawler.test" }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rowOf = (html: string, email: string) => `<li ${html.split("<li ").find((row) => row.includes(email)) ?? ""}`;
const listStatus = (html: string) => html.match(/<p role="status"[^>]*>([^<]*)<\/p>/)?.[1];
const inviteForm = (html: string) => html.slice(html.indexOf("Invite someone"), html.indexOf("<script"));
const answered = (change: string, answer: unknown, { pending = false, confirming = null as string | null } = {}) => {
  react.actions = ["change", "remove", "revoke", "invite"].map((c): [unknown, boolean] => (c === change ? [answer, pending] : IDLE));
  react.flow = { sent: { change, before: BEFORE }, confirming, focus: null };
};

beforeEach(() => {
  react.actions = [];
  react.states = [];
  react.flow = null;
});

test("each member shows their name, address, role and when they joined, you are marked, and a nameless one shows the address once", () => {
  const html = render();
  expect(text(rowOf(html, "ana@acme.test"))).toBe("Ana (you) ana@acme.test Owner Joined 2026-09-20 10:00 UTC");
  expect(text(rowOf(html, "bo@acme.test"))).toBe("bo@acme.test Admin Joined 2026-09-22 10:00 UTC Make member bo@acme.test Remove bo@acme.test");
});

test("an owner or admin can switch a member or an admin and remove them, but not an owner and not themselves", () => {
  const html = render();
  expect(rowOf(html, "lee@acme.test")).toMatch(/<input type="hidden" name="memberId" value="m-2"\/><input type="hidden" name="role" value="admin"\/><button type="submit"[^>]*>Make admin<span class="sr-only"> Lee<\/span><\/button>/);
  expect(rowOf(html, "bo@acme.test")).toMatch(/<input type="hidden" name="role" value="member"\/><button type="submit"[^>]*>Make member<span class="sr-only"> bo@acme.test<\/span>/);
  expect(rowOf(html, "lee@acme.test")).toMatch(/<button type="button"[^>]*>Remove<span class="sr-only"> Lee<\/span><\/button>/);
  for (const untouchable of ["ana@acme.test", "cy@acme.test"]) expect(rowOf(html, untouchable)).not.toContain("<button");
  const asAdmin = render(true, members.map((m) => ({ ...m, you: m.id === "m-3" })));
  expect(rowOf(asAdmin, "bo@acme.test")).not.toContain("<button");
  expect(rowOf(asAdmin, "lee@acme.test")).toContain("Make admin");
});

test("Remove asks first, naming who goes and what they lose, and only for that row", () => {
  react.flow = { sent: null, confirming: "m-2", focus: null };
  const html = render();
  const lee = rowOf(html, "lee@acme.test");
  expect(text(lee)).toContain("Remove Lee? They lose access to this workspace at once, in every browser they use. Remove Lee Keep Lee");
  expect(lee).toMatch(/<input type="hidden" name="memberId" value="m-2"\/><p id="remove-m-2" class="wrap-anywhere">/);
  expect(lee).toMatch(/<button type="submit" aria-describedby="remove-m-2"[^>]*>Remove<span class="sr-only"> Lee<\/span><\/button><button type="button" aria-describedby="remove-m-2"[^>]*>Keep<span class="sr-only"> Lee<\/span><\/button>/);
  expect(lee).not.toContain("Make admin");
  expect(text(rowOf(html, "bo@acme.test"))).toContain("Make member bo@acme.test Remove bo@acme.test");
});

test("while a removal is sent it says so, and every button in the panel holds", () => {
  answered("remove", {}, { pending: true, confirming: "m-2" });
  const html = render();
  expect(rowOf(html, "lee@acme.test")).toMatch(/<button type="submit" aria-describedby="remove-m-2" aria-disabled="true"[^>]*>Removing…<\/button><button type="button" aria-describedby="remove-m-2" aria-disabled="true"/);
  expect(rowOf(html, "bo@acme.test").match(/aria-disabled="true"/g)).toHaveLength(2);
  expect(rowOf(html, "max@acme.test")).toContain('aria-disabled="true"');
  expect(inviteForm(html)).toMatch(/<button type="submit" aria-disabled="true"[^>]*>Invite<\/button>/);
  answered("invite", {}, { pending: true, confirming: "m-2" });
  expect(rowOf(render(), "lee@acme.test")).toMatch(/<button type="submit" aria-describedby="remove-m-2" aria-disabled="true"[^>]*>Remove<span class="sr-only"> Lee<\/span><\/button>/);
});

test("a refused removal stays open with its refusal under its buttons, and nothing else is said", () => {
  answered("remove", { error: "They could not be removed. Try again." }, { confirming: "m-2" });
  const html = render();
  expect(rowOf(html, "lee@acme.test")).toMatch(/Keep<span class="sr-only"> Lee<\/span><\/button><\/div><p role="alert"[^>]*>They could not be removed. Try again.<\/p><\/form>/);
  expect(listStatus(html)).toBe("");
  expect(html.match(/role="alert"/g)).toHaveLength(1);
});

test("a refusal whose own place is gone with the refresh is said under the heading instead", () => {
  const OWNERS_AND_ADMINS = "Only an owner or admin of this workspace can invite people or change who is in it.";
  const alerts = (html: string) => [...html.matchAll(/<p role="alert"[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);
  answered("remove", { error: OWNERS_AND_ADMINS }, { confirming: "m-2" });
  expect(alerts(render(false))).toEqual([OWNERS_AND_ADMINS]);
  answered("remove", { error: "An owner is not removed here." }, { confirming: "m-4" });
  const ownerNow = render();
  expect(alerts(ownerNow)).toEqual(["An owner is not removed here."]);
  expect(ownerNow.indexOf('role="alert"')).toBeLessThan(ownerNow.indexOf("<ul"));
  answered("invite", { error: OWNERS_AND_ADMINS });
  expect(alerts(render(false))).toEqual([OWNERS_AND_ADMINS]);
  answered("invite", { error: "That address is already in this workspace." });
  const inPlace = render();
  expect(inPlace.indexOf('role="alert"')).toBeGreaterThan(inPlace.indexOf("Invite someone"));
});

test("what a change did is said once its answer arrives, a refusal is an alert, and nothing is said before the answer or while anything is sent", () => {
  answered("change", { done: "Lee is now an admin." });
  expect(listStatus(render())).toBe("Lee is now an admin.");
  answered("change", { error: "Their role could not be changed. Try again." });
  const refused = render();
  expect(listStatus(refused)).toBe("");
  expect(refused).toMatch(/<p role="alert"[^>]*>Their role could not be changed. Try again.<\/p>/);
  answered("change", BEFORE);
  expect(listStatus(render())).toBe("");
  answered("change", { done: "Lee is now an admin." }, { pending: true });
  expect(listStatus(render())).toBe("");
  answered("revoke", { done: "The invitation for max@acme.test is revoked." });
  react.actions[3] = [{}, true];
  expect(listStatus(render())).toBe("");
});

test("only what the latest change did is said: a revoke hides an invitation's status and refusal, and an invitation hides the list's", () => {
  const results: Array<[unknown, boolean]> = [IDLE, IDLE, [{ done: "The invitation for max@acme.test is revoked." }, false], [{ invited: "max@acme.test", error: "x" }, false]];
  react.actions = [...results];
  react.flow = { sent: { change: "revoke", before: BEFORE }, confirming: null, focus: null };
  const afterRevoke = render();
  expect(listStatus(afterRevoke)).toBe("The invitation for max@acme.test is revoked.");
  expect(inviteForm(afterRevoke)).not.toMatch(/Ask them to sign in|invite-error|aria-invalid/);
  react.actions = [...results];
  react.flow = { sent: { change: "invite", before: BEFORE }, confirming: null, focus: null };
  const afterInvite = render();
  expect(listStatus(afterInvite)).toBe("");
  expect(text(inviteForm(afterInvite))).toContain("Invited max@acme.test. Ask them to sign in");
});

test("invitations that can still be used are listed with their role and expiry, and can be revoked", () => {
  const html = render();
  expect(text(html)).toContain("Invited max@acme.test Admin Expires 2026-10-03 10:00 UTC Revoke the invitation for max@acme.test");
  expect(html).toMatch(/<input type="hidden" name="invitationId" value="inv-1"\/><button type="submit"/);
});

test("an owner or admin invites by address, as a member unless they pick admin", () => {
  const form = inviteForm(render());
  expect(form).toMatch(/<input type="email" required=""[^>]*name="email" value=""\/>/);
  expect(form).toMatch(/<span class="text-sm text-muted">Role<\/span><select name="role"[^>]*><option value="member" selected="">Member<\/option><option value="admin">Admin<\/option><\/select>/);
  expect(form).toMatch(/<button type="submit"[^>]*>Invite<\/button>/);
});

test("after an invitation the page says where the invited person signs in, and a refusal keeps the address and role for another try", () => {
  answered("invite", { invited: "max@acme.test" });
  expect(text(inviteForm(render()))).toContain("Invite Invited max@acme.test. Ask them to sign in at app.usetrawler.test with this address; no email is sent.");
  answered("invite", { error: "That address is already in this workspace.", field: "email" });
  react.states = ["max@acme.test", "admin"];
  const refused = inviteForm(render());
  expect(refused).toMatch(/<input type="email" required=""[^>]*aria-invalid="true" aria-describedby="invite-error"[^>]*name="email" value="max@acme.test"\/>/);
  expect(refused).toMatch(/<option value="admin" selected="">Admin<\/option>/);
  expect(refused).toMatch(/<p id="invite-error" role="alert"[^>]*>That address is already in this workspace.<\/p>/);
  answered("invite", { error: "Too many invitations. Wait a few minutes and try again." });
  const notAboutTheAddress = inviteForm(render());
  expect(notAboutTheAddress).not.toMatch(/aria-invalid|aria-describedby="invite-error"/);
  expect(notAboutTheAddress).toMatch(/<p id="invite-error" role="alert"[^>]*>Too many invitations. Wait a few minutes and try again.<\/p>/);
  answered("invite", { error: "That address is already in this workspace.", field: "email" }, { pending: true });
  const sending = inviteForm(render());
  expect(sending).not.toContain("invite-error");
  expect(sending).toMatch(/<input type="email"[^>]*readOnly=""/);
  expect(sending).toMatch(/<select name="role" aria-disabled="true"/);
  expect(sending).toMatch(/<button type="submit" aria-disabled="true"[^>]*>Inviting…<\/button>/);
});

test("a member reads who is in the workspace and who is invited, with nothing to change", () => {
  const html = render(false);
  expect(html).not.toMatch(/<form|<button|<input/);
  expect(text(html)).toContain("Invited max@acme.test Admin Expires");
  expect(text(html)).toContain("Only an owner or admin of this workspace can invite people or change who is in it.");
});

test("the invited status and role labels read as the page words them", () => {
  expect(invitedStatus("max@acme.test", "app.usetrawler.com")).toBe("Invited max@acme.test. Ask them to sign in at app.usetrawler.com with this address; no email is sent.");
  expect([roleLabel("owner"), roleLabel("admin"), roleLabel("member"), roleLabel("admin,member")]).toEqual(["Owner", "Admin", "Member", "Admin, Member"]);
});

test("an invitation whose address has since got a workspace says it can no longer be used, and can still be revoked", () => {
  const taken = { id: "inv-2", email: "gone@acme.test", role: "member", expiresAt: "2026-10-03T10:00:00.000Z", addressHasWorkspace: true };
  const html = renderToStaticMarkup(createElement(Members, { members, invitations: [...invitations, taken], canManage: true, signInAt: "app.usetrawler.test" }));
  expect(text(rowOf(html, "gone@acme.test"))).toContain("This address has since signed in and belongs to a workspace, so it can no longer use this invitation.");
  expect(rowOf(html, "gone@acme.test")).toContain('value="inv-2"');
  expect(text(rowOf(html, "max@acme.test"))).toContain("max@acme.test");
  expect(text(rowOf(html, "max@acme.test"))).not.toContain("can no longer use");
});

test("only those who manage the workspace see that an invited address already has one", () => {
  const taken = { id: "inv-2", email: "gone@acme.test", role: "member", expiresAt: "2026-10-03T10:00:00.000Z", addressHasWorkspace: true };
  const html = renderToStaticMarkup(createElement(Members, { members, invitations: [taken], canManage: false, signInAt: "app.usetrawler.test" }));
  expect(text(html)).toContain("gone@acme.test");
  expect(text(html)).not.toContain("can no longer use");
});
