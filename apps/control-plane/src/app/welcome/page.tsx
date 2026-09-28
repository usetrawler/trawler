import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BrandMark } from "../../components/brand-mark.tsx";
import { SignOutButton } from "../../components/sign-out-button.tsx";
import { ThemeToggle } from "../../components/theme-toggle.tsx";
import { getAuth, signedInPerson } from "../../server/auth.ts";
import { WorkspaceChoice } from "./choice.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Choose your workspace" };

export default async function WelcomePage() {
  const person = await signedInPerson(await headers());
  if (!person) redirect("/sign-in");
  if ("member" in person) redirect("/");
  const { newcomer } = person;
  const invitations = await getAuth().invitationsFor(newcomer);
  const rows = invitations.map(({ id, orgName, role, inviterName, inviterEmail, inviterEmailVerified }) => ({ id, orgName, role, inviterName, inviterEmail, inviterEmailVerified }));
  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 md:px-8">
        <p className="flex items-center gap-2 text-lg font-bold tracking-tight"><BrandMark />trawler</p>
        <div className="flex items-center gap-3">
          <SignOutButton className="h-8 shrink-0 border border-line px-3 text-xs hover:border-ink" />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12 md:py-16">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-xs tracking-[0.2em] text-muted uppercase"><span aria-hidden className="h-2 w-2 bg-ok" />Signed in as<span className="min-w-0 tracking-normal normal-case wrap-anywhere text-ink">{newcomer.email}</span></p>
        <p className="font-mono text-xs tracking-[0.2em] text-action-ink uppercase">Your workspace</p>
        <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">{rows.length === 0 ? "Your invitation is no longer open." : rows.length === 1 ? "You were invited to a workspace." : `You were invited to ${rows.length} workspaces.`}</h1>
        <p className="max-w-xl text-lg text-muted">
          {rows.length === 0
            ? "It was revoked, it expired or it was already used. Ask for a new one, or start your own workspace."
            : `Join only a workspace you know. What you add there belongs to it: everyone in it sees your projects and test accounts, and its runs are paid with the model key it holds.${rows.length > 1 ? " Joining one withdraws the other invitations." : ""}`}
        </p>
        <WorkspaceChoice invitations={rows} />
      </main>
    </div>
  );
}
