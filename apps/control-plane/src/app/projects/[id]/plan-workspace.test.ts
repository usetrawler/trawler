import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Persona } from "@usetrawler/protocol";
import type { AccountView } from "./plan-actions.ts";
import { PlanWorkspace } from "./plan-workspace.tsx";

const WITHOUT_ACCOUNT = "People without a test account sign up the way a new user would, if your product lets them, with a password Trawler makes up. They cannot confirm an email address yet.";
const accounts: AccountView[] = [{ ref: "account-1", username: "kwame@acme.test", hint: "…1234" }];
const ama: Persona = { id: "ama", name: "Ama", brief: "Brand new." };
const kwame: Persona = { id: "kwame", name: "Kwame", brief: "Has an account.", accountRef: "account-1" };

function render(initialPersonas: Persona[], initialAccounts: AccountView[]) {
  return renderToStaticMarkup(createElement(PlanWorkspace, { projectId: "p1", initialPersonas, initialGoals: [{ id: "g", instruction: "Send an invoice." }], initialAccounts, keyHint: null, canManageKey: true }));
}

describe("PlanWorkspace", () => {
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
