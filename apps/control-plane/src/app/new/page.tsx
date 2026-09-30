import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AppShell } from "../../components/app-shell.tsx";
import { withOrg } from "../../db/tenancy.ts";
import { projectLimitMessage } from "../../runs/plan-limits.ts";
import { projectLimitReached } from "../../runs/plans.ts";
import { signedInMember } from "../../server/auth.ts";
import { getDb } from "../../server/db.ts";
import { shellFor } from "../../server/shell.ts";
import { SetupWizard } from "./setup-wizard.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const shell = await shellFor(member);
  const limit = await withOrg(getDb(), member.orgId, (tx) => projectLimitReached(tx, member.orgId));
  if (limit) {
    return (
      <AppShell shell={shell} current="new">
        <div className="flex max-w-2xl flex-col gap-4">
          <p className="font-mono text-xs tracking-[0.2em] text-action-ink uppercase">New project</p>
          <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">This workspace has reached its project limit.</h1>
          <p className="text-lg text-muted">{projectLimitMessage(limit.plan, limit.projects)}</p>
          <p><Link href="/" className="underline underline-offset-4 hover:text-action-ink">Go to your projects</Link></p>
        </div>
      </AppShell>
    );
  }
  return (
    <AppShell shell={shell} current="new">
      <SetupWizard
        intro={
          <div className="flex flex-col gap-4">
            <p className="font-mono text-xs tracking-[0.2em] text-action-ink uppercase">New project</p>
            <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">What should Trawler use?</h1>
            <p className="max-w-xl text-lg text-muted">Paste a real product that runs in a browser: production, staging or a preview. We read the public page, tell you what we think the product does, and propose people to try the features you choose.</p>
          </div>
        }
      />
    </AppShell>
  );
}
