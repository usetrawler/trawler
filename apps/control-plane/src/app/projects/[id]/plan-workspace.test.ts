import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Persona } from "@usetrawler/protocol";
import type { AccountView } from "./plan-actions.ts";
import type { PlanPerson } from "./plan-workspace.tsx";
import { PlanWorkspace } from "./plan-workspace.tsx";
import type { WorkspacePlan } from "../../../runs/plan-limits.ts";

const accounts: AccountView[] = [{ ref: "account-1", username: "kwame@acme.test", hint: "…1234" }];
const ama: Persona = { id: "ama", name: "Ama", brief: "Brand new." };
const kwame: Persona = { id: "kwame", name: "Kwame", brief: "Has an account.", accountRef: "account-1" };

function render(initialPersonas: PlanPerson[], initialAccounts: AccountView[], authorisedBefore = false, initialGoals = initialPersonas.map((p, i) => ({ id: `g${i}`, instruction: "Send an invoice.", personaId: p.id }))) {
  return renderToStaticMarkup(createElement(PlanWorkspace, { projectId: "p1", projectName: "Acme", initialPersonas, initialGoals, initialAccounts, keyHint: null, canManageKey: true, authorisedBefore }));
}

describe("PlanWorkspace", () => {
  it("shows the order of play across people, marks each new turn, and hides it for a single person", () => {
    const html = render([ama, kwame], accounts, false, [
      { id: "submit", instruction: "Submit a pitch.", personaId: "ama" },
      { id: "review", instruction: "Review Ama's pitch.", personaId: "kwame" },
      { id: "decision", instruction: "See the decision.", personaId: "ama" },
    ]);
    const order = html.slice(html.indexOf('id="order-of-play"'));
    expect(order).toMatch(/01<\/span><span[^>]*><span[^>]*>Ama<\/span><span[^>]*>Submit a pitch\.[^]*02<\/span><span[^>]*><span[^>]*>Kwame<\/span>[^]*03<\/span><span[^>]*><span[^>]*>Ama<\/span>/);
    expect(order).toContain('aria-live="polite"');
    expect(order).toContain("3 turns.");
    expect(order).toMatch(/aria-label="Move step 1, Ama up" disabled=""/);
    expect(order).toMatch(/aria-label="Move step 3, Ama down" disabled=""/);
    expect(render([ama], [])).not.toContain("Order of play");
  });

  it("shows each person's own goals on their card", () => {
    const html = render([ama, kwame], accounts, false, [
      { id: "submit", instruction: "Submit a pitch.", personaId: "ama" },
      { id: "review", instruction: "Review a pitch.", personaId: "kwame" },
      { id: "approve", instruction: "Approve a pitch.", personaId: "kwame" },
    ]);
    const cards = html.split('aria-label="Goals of ').slice(1);
    expect(cards[0]).toMatch(/^Ama"[\s\S]*Submit a pitch\.(?![\s\S]*Review a pitch)/);
    expect(cards[1]).toMatch(/^Kwame"[\s\S]*Review a pitch\.[\s\S]*Approve a pitch\./);
    expect(html).toContain('aria-label="Remove goal 1 of Kwame"');
    expect(html).not.toContain('aria-label="Remove goal 1 of Ama"');
  });

  it("passes on to Start whether the project has had a run, so the box is asked only before the first", () => {
    expect(render([ama], [])).toContain('name="authorised"');
    expect(render([ama], [], true)).not.toContain('name="authorised"');
  });

  it("each card says how its person gets in, and the separate test accounts section is gone", () => {
    const html = render([ama, kwame], accounts);
    expect(html).not.toContain("Test accounts");
    expect(html.match(/aria-label="Sign-in for Ama"/g)).toHaveLength(1);
    expect(html).toMatch(/<option value="signs-up" selected="">Signs up as a new user<\/option>/);
    expect(html).toMatch(/<option value="account-1" selected="">Signs in as kwame@acme\.test<\/option>/);
    expect(html).toContain("password …1234");
    expect(html).toContain(">+ Add account for Ama<");
    expect(html).toContain("Remove kwame@acme.test from the project");
  });

  it("a person who has to sign in without an account says so on the card, and Start refuses until one is chosen", () => {
    const html = render([{ ...ama, signsIn: true }, kwame], accounts);
    expect(html).toMatch(/<option value="" selected="">Choose a test account<\/option>/);
    expect(html.match(/Ama needs a test account to sign in\./g)).toHaveLength(2);
    expect(html).toMatch(/id="start-blocked"[^>]*>Ama needs a test account to sign in\.</);
    expect(render([kwame], accounts)).not.toContain("needs a test account");
    expect(html).toMatch(/aria-label="Sign-in for Ama" aria-invalid="true" aria-describedby="sign-in-ama"/);
  });

  it("an account that is gone never shows as someone else's: the card asks for one and Start refuses", () => {
    const html = render([{ ...kwame, accountRef: "account-gone" }], accounts);
    expect(html).toMatch(/<option value="" selected="">Choose a test account<\/option>/);
    expect(html).not.toMatch(/<option value="account-1" selected="">/);
    expect(html).toMatch(/id="start-blocked"[^>]*>Kwame needs a test account to sign in\.</);
  });
  it("stops Start while the plan has more people than the workspace's plan takes, saying what to do", () => {
    const free: WorkspacePlan = { plan: "free", limits: { projects: 1, runsPerDay: 3, people: 4 } };
    const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, brief: "b" }));
    const at = (n: number, workspacePlan = free) => renderToStaticMarkup(createElement(PlanWorkspace, {
      projectId: "p1", projectName: "Acme", initialPersonas: people(n), initialGoals: people(n).map((p) => ({ id: `g-${p.id}`, instruction: "Look.", personaId: p.id })),
      initialAccounts: [], keyHint: null, canManageKey: true, authorisedBefore: true, workspacePlan,
    }));
    expect(at(5)).toMatch(/id="start-blocked"[^>]*>The Free plan takes up to 4 people in a run, and the plan on this project has 5\. Remove people from the plan, run it on your own machine with the local runner, or write to contact@usetrawler\.com about the Team plan\.</);
    expect(at(4)).not.toContain('id="start-blocked"');
    expect(at(5, { plan: "team", limits: { projects: 3, runsPerDay: 30, people: 12 } })).not.toContain('id="start-blocked"');
  });
});
