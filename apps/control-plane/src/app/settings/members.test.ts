import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ actions: [] as Array<[unknown, boolean]>, states: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (_action: unknown, initial: unknown) => {
    const [result, pending] = react.actions.shift() ?? [initial, false];
    return [result, () => {}, pending];
  },
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
const invitations = [{ id: "inv-1", email: "max@acme.test", role: "admin", expiresAt: "2026-10-03T10:00:00.000Z" }];
const IDLE: [unknown, boolean] = [{}, false];
const render = (canManage = true) => renderToStaticMarkup(createElement(Members, { members, invitations, canManage, signInAt: "app.usetrawler.test" }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rowOf = (html: string, email: string) => html.split("<li ").find((row) => row.includes(email)) ?? "";
const listStatus = (html: string) => html.match(/<p role="status"[^>]*>([^<]*)<\/p>/)?.[1];
const inviteForm = (html: string) => html.slice(html.indexOf("Invite someone"));

beforeEach(() => {
  react.actions = [];
  react.states = [];
});

test("each member shows their name, address, role and when they joined, and you are marked", () => {
  const html = render();
  expect(text(rowOf(html, "ana@acme.test"))).toContain("Ana (you) ana@acme.test Owner Joined 2026-09-20 10:00 UTC");
  expect(text(rowOf(html, "bo@acme.test"))).toContain("bo@acme.test bo@acme.test Admin Joined 2026-09-22 10:00 UTC");
});

test("an owner or admin can switch a member or an admin and remove them, but not an owner and not themselves", () => {
  const html = render();
  expect(rowOf(html, "lee@acme.test")).toMatch(/<input type="hidden" name="memberId" value="m-2"\/><input type="hidden" name="role" value="admin"\/><button type="submit"[^>]*>Make admin<span class="sr-only"> Lee<\/span><\/button>/);
  expect(rowOf(html, "bo@acme.test")).toMatch(/<input type="hidden" name="role" value="member"\/><button type="submit"[^>]*>Make member<span class="sr-only"> bo@acme.test<\/span>/);
  expect(rowOf(html, "lee@acme.test")).toMatch(/<button type="button"[^>]*>Remove<span class="sr-only"> Lee<\/span><\/button>/);
  for (const untouchable of ["ana@acme.test", "cy@acme.test"]) expect(rowOf(html, untouchable)).not.toContain("<button");
  const asAdmin = renderToStaticMarkup(createElement(Members, { members: members.map((m) => ({ ...m, you: m.id === "m-3" })), invitations, canManage: true, signInAt: "app.usetrawler.test" }));
  expect(rowOf(asAdmin, "bo@acme.test")).not.toContain("<button");
  expect(rowOf(asAdmin, "lee@acme.test")).toContain("Make admin");
});

test("Remove asks first, naming who goes and what they lose, and only for that row", () => {
  react.states = [{}, { id: "m-2" }];
  const html = render();
  const lee = rowOf(html, "lee@acme.test");
  expect(text(lee)).toContain("Remove Lee? They lose access to this workspace at once, in every browser they use. Remove Lee Keep Lee");
  expect(lee).toMatch(/<input type="hidden" name="memberId" value="m-2"\/><p id="remove-m-2" class="wrap-anywhere">/);
  expect(lee).toMatch(/<button type="submit" aria-describedby="remove-m-2"[^>]*>Remove<span class="sr-only"> Lee<\/span><\/button><button type="button" aria-describedby="remove-m-2"[^>]*>Keep<span class="sr-only"> Lee<\/span><\/button>/);
  expect(lee).not.toContain("Make admin");
  expect(text(rowOf(html, "bo@acme.test"))).toContain("Make member bo@acme.test Remove bo@acme.test");
});

test("a refused removal stays open with the refusal under its buttons, and Keep gives focus back to Remove", () => {
  react.states = [{}, { id: "m-2", error: "They could not be removed. Try again." }];
  const refused = render();
  expect(rowOf(refused, "lee@acme.test")).toMatch(/Keep<span class="sr-only"> Lee<\/span><\/button><\/div><p role="alert"[^>]*>They could not be removed. Try again.<\/p><\/form>/);
  expect(listStatus(refused)).toBe("");
  react.actions = [IDLE, [{}, true], IDLE];
  react.states = [{}, { id: "m-2", error: "They could not be removed. Try again." }];
  expect(render()).not.toContain('role="alert"');
  react.states = [{}, null, "m-2"];
  const kept = render();
  expect(rowOf(kept, "lee@acme.test")).toMatch(/<button type="button" autofocus=""[^>]*>Remove<span class="sr-only"> Lee<\/span>/);
  expect(rowOf(kept, "bo@acme.test")).not.toContain("autofocus");
});

test("while a removal is sent, both of its buttons hold and it says so", () => {
  react.actions = [IDLE, [{}, true], IDLE];
  react.states = [{}, { id: "m-2" }];
  const lee = rowOf(render(), "lee@acme.test");
  expect(lee).toMatch(/<button type="submit" aria-describedby="remove-m-2" aria-disabled="true"[^>]*>Removing…<\/button>/);
  expect(lee).toMatch(/<button type="button" aria-describedby="remove-m-2" aria-disabled="true"[^>]*>Keep<span class="sr-only"> Lee<\/span><\/button>/);
});

test("what a change did is said once it is done, a refusal is an alert, and neither shows while something is sent", () => {
  react.states = [{ done: "Lee is now an admin." }, null, null, "list"];
  expect(listStatus(render())).toBe("Lee is now an admin.");
  react.states = [{ error: "An owner's role is not changed here." }, null, null, "list"];
  const refused = render();
  expect(listStatus(refused)).toBe("");
  expect(refused).toMatch(/<p role="alert"[^>]*>An owner&#x27;s role is not changed here.<\/p>/);
  react.actions = [[{}, true], IDLE, IDLE];
  react.states = [{ done: "Lee is now an admin." }, null, null, "list"];
  expect(listStatus(render())).toBe("");
  react.actions = [[{}, true], IDLE, IDLE];
  react.states = [{ error: "An owner's role is not changed here." }, null, null, "list"];
  const sending = render();
  expect(sending).not.toContain('role="alert"');
  expect(rowOf(sending, "lee@acme.test").match(/aria-disabled="true"/g)).toHaveLength(2);
  expect(rowOf(sending, "max@acme.test")).toContain('aria-disabled="true"');
});

test("only what the latest change did is said, so a revoked invitation no longer says to sign in", () => {
  const revokedThenInvited: Array<[unknown, boolean]> = [IDLE, IDLE, [{ done: "The invitation for max@acme.test is revoked." }, false], [{ invited: "max@acme.test" }, false]];
  react.actions = [...revokedThenInvited];
  react.states = [{ done: "The invitation for max@acme.test is revoked." }, null, null, "list"];
  const afterRevoke = render();
  expect(listStatus(afterRevoke)).toBe("The invitation for max@acme.test is revoked.");
  expect(text(inviteForm(afterRevoke))).not.toContain("Ask them to sign in");
  react.actions = [...revokedThenInvited];
  react.states = [{ done: "The invitation for max@acme.test is revoked." }, null, null, "invite"];
  const afterInvite = render();
  expect(listStatus(afterInvite)).toBe("");
  expect(text(inviteForm(afterInvite))).toContain("Invited max@acme.test. Ask them to sign in");
  react.actions = [IDLE, IDLE, [{ done: "The invitation for max@acme.test is revoked." }, false], [{ error: "That address is already in this workspace." }, false]];
  react.states = [{ done: "The invitation for max@acme.test is revoked." }, null, null, "list"];
  const refusedThenRevoked = inviteForm(render());
  expect(refusedThenRevoked).not.toContain("invite-error");
  expect(refusedThenRevoked).not.toContain("aria-invalid");
});

test("invitations that can still be used are listed with their role and expiry, and can be revoked", () => {
  const html = render();
  expect(text(html)).toContain("Invited max@acme.test Admin Expires 2026-10-03 10:00 UTC Revoke the invitation for max@acme.test");
  expect(html).toMatch(/<input type="hidden" name="invitationId" value="inv-1"\/><button type="submit"/);
});

test("an owner or admin invites by address, as a member unless they pick admin", () => {
  const form = inviteForm(render());
  expect(form).toMatch(/<input type="email" required=""[^>]*name="email" value=""\/>/);
  expect(form).toMatch(/<select name="role"[^>]*><option value="member" selected="">Member<\/option><option value="admin">Admin<\/option><\/select>/);
  expect(form).toMatch(/<button type="submit"[^>]*>Invite<\/button>/);
});

test("after an invitation the page says where the invited person signs in, and a refusal keeps the address and role for another try", () => {
  react.actions = [IDLE, IDLE, IDLE, [{ invited: "max@acme.test" }, false]];
  expect(text(inviteForm(render()))).toContain("Invite Invited max@acme.test. Ask them to sign in at app.usetrawler.test with this address; no email is sent.");
  react.actions = [IDLE, IDLE, IDLE, [{ error: "That address is already in this workspace." }, false]];
  react.states = [{}, null, null, "invite", "max@acme.test", "admin"];
  const refused = inviteForm(render());
  expect(refused).toMatch(/<input type="email" required=""[^>]*aria-invalid="true" aria-describedby="invite-error"[^>]*name="email" value="max@acme.test"\/>/);
  expect(refused).toMatch(/<option value="admin" selected="">Admin<\/option>/);
  expect(refused).toMatch(/<p id="invite-error" role="alert"[^>]*>That address is already in this workspace.<\/p>/);
  react.actions = [IDLE, IDLE, IDLE, [{ error: "That address is already in this workspace." }, true]];
  const sending = inviteForm(render());
  expect(sending).not.toContain("invite-error");
  expect(sending).toMatch(/<input type="email"[^>]*readOnly=""/);
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
