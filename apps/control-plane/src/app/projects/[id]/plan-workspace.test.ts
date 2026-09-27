import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Persona } from "@usetrawler/protocol";
import type { AccountView } from "./plan-actions.ts";
import { PlanWorkspace } from "./plan-workspace.tsx";

const WITHOUT_ACCOUNT = "People without a test account sign up the way a new user would, if your product lets them, with an example.com address and a password Trawler makes up. They cannot receive email yet.";
const accounts: AccountView[] = [{ ref: "account-1", username: "kwame@acme.test", hint: "…1234" }];
const ama: Persona = { id: "ama", name: "Ama", brief: "Brand new." };
const kwame: Persona = { id: "kwame", name: "Kwame", brief: "Has an account.", accountRef: "account-1" };

function render(initialPersonas: Persona[], initialAccounts: AccountView[], authorisedBefore = false, initialGoals = initialPersonas.map((p, i) => ({ id: `g${i}`, instruction: "Send an invoice.", personaId: p.id }))) {
  return renderToStaticMarkup(createElement(PlanWorkspace, { projectId: "p1", projectName: "Acme", initialPersonas, initialGoals, initialAccounts, keyHint: null, canManageKey: true, authorisedBefore }));
}

describe("PlanWorkspace", () => {
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

  it("says what people without a test account do, next to the way to add one", () => {
    const html = render([ama], []);
    expect(html).toContain("Your product needs sign-in? Add a test account");
    expect(html).toContain(WITHOUT_ACCOUNT);
  });

  it("says it with the test accounts while someone still has none, and not once everyone has one", () => {
    const mixed = render([ama, kwame], accounts);
    expect(mixed).toContain("Test accounts");
    expect(mixed).toContain(WITHOUT_ACCOUNT);
    const everyone = render([kwame], accounts);
    expect(everyone).toContain("Test accounts");
    expect(everyone).not.toContain(WITHOUT_ACCOUNT);
  });
});
