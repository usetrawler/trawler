import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { runView } from "../../../runs/report.ts";
import { runTitle } from "../../../runs/status.ts";
import { runFor } from "../../../server/runs.ts";
import { shellFor } from "../../../server/shell.ts";
import { RunLive } from "./run-live.tsx";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await runFor(await headers(), id);
  if (!access.signedIn) redirect("/sign-in");
  if (!access.run) notFound();
  const shell = await shellFor(access.member);
  const project = shell.workspace.projects.find((p) => p.id === access.run!.projectId);
  return (
    <AppShell shell={shell} current={{ project: access.run.projectId }} parent>
      <nav aria-label="Breadcrumb" className="mb-[34px]">
        <ol className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted">
          {project && <><li><a href={`/projects/${project.id}`} className="-my-2 inline-block py-2 hover:text-ink">{project.name}</a></li><li aria-hidden>/</li></>}
          <li><a href={project ? `/projects/${project.id}/runs` : "/runs"} className="-my-2 inline-block py-2 hover:text-ink">Runs</a></li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="font-bold text-ink">{runTitle(access.run.number)}</li>
        </ol>
      </nav>
      <RunLive initial={JSON.parse(JSON.stringify({ run: access.run, view: runView(access.run) }))} />
    </AppShell>
  );
}
