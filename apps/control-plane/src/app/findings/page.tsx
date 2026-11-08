import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { withOrg } from "../../db/tenancy.ts";
import { workspaceRuns } from "../../projects/overview.ts";
import { openFindings } from "../../projects/project-home.ts";
import { signedInMember } from "../../server/auth.ts";
import { getDb } from "../../server/db.ts";
import { shellFor } from "../../server/shell.ts";
import { FindingsView } from "./findings-view.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Findings" };

export default async function FindingsPage() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const shell = await shellFor(member);
  if (shell.workspace.projects.length === 0) redirect("/new");
  const [findings, going] = await withOrg(getDb(), orgId, (tx) => Promise.all([openFindings(tx, orgId), workspaceRuns(tx, orgId, { active: true, size: 10 })]));
  return (
    <AppShell shell={shell} current="findings">
      <FindingsView projects={shell.workspace.projects} findings={findings} going={going.runs} />
    </AppShell>
  );
}
