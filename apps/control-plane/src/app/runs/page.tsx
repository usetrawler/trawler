import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { PageHead, PrimaryLink } from "../../components/page-head.tsx";
import { withOrg } from "../../db/tenancy.ts";
import { runCounts, workspaceRuns } from "../../projects/overview.ts";
import { signedInMember } from "../../server/auth.ts";
import { getDb } from "../../server/db.ts";
import { shellFor } from "../../server/shell.ts";
import { parseRunsQuery, RunsView } from "./runs-view.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Runs" };

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ show?: string | string[]; via?: string | string[]; before?: string | string[] }> }) {
  const { show, origin, before } = parseRunsQuery(await searchParams);
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const [history, counts] = await withOrg(getDb(), orgId, (tx) => Promise.all([workspaceRuns(tx, orgId, { show, before, ...(origin === "any" ? {} : { origin }) }), runCounts(tx, orgId, undefined, undefined, origin === "any" ? undefined : origin)]));
  const shell = await shellFor(member);
  const newest = shell.workspace.projects[0];
  return (
    <AppShell shell={shell} current="runs" wide>
      <RunsView
        head={<PageHead eyebrow="Run history" title="Every run, newest first." subtitle="Each result stays tied to the plan it ran with, even after the plan changes." action={<PrimaryLink href={newest ? `/projects/${newest.id}#start` : "/new"}>New run</PrimaryLink>} />}
        basePath="/runs"
        show={show} origin={origin} counts={counts} runs={history.runs} olderThan={history.olderThan} paged={before !== undefined}
      />
    </AppShell>
  );
}
