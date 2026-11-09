import { PageHead } from "../../components/page-head.tsx";
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
        <div className="flex max-w-3xl flex-col gap-4">
          <PageHead flush eyebrow={shell.workspace.name} title="New project" subtitle={<>This workspace has reached its project limit. {projectLimitMessage(limit.plan, limit.projects)}</>} />
          <p><Link href="/" className="underline underline-offset-4 hover:text-ink">Go to Overview</Link></p>
        </div>
      </AppShell>
    );
  }
  return (
    <AppShell shell={shell} current="new">
      <div className="max-w-3xl">
        <SetupWizard
          intro={<PageHead flush eyebrow={shell.workspace.name} title="New project" subtitle="Paste a real product that runs in a browser: production, staging or a preview. We read the public page, tell you what we think the product does, and propose people to try the features you choose." />}
        />
      </div>
    </AppShell>
  );
}
