import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { screenCapture } from "../../../artifacts/artifacts.ts";
import { AppShell } from "../../../components/app-shell.tsx";
import { runTitle } from "../../../runs/status.ts";
import { signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { shellFor } from "../../../server/shell.ts";

export const dynamic = "force-dynamic";

export default async function CapturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const capture = await screenCapture(getDb(), member.orgId, id);
  if (!capture) notFound();
  const shell = await shellFor(member);
  const project = shell.workspace.projects.find((p) => p.id === capture.projectId);
  const title = capture.findingTitle ?? "Screen capture";
  return (
    <AppShell shell={shell} current={{ project: capture.projectId }} parent>
      <nav aria-label="Breadcrumb" className="mb-[34px]">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-4 font-mono text-[10px] text-muted">
          {project && <><li><a href={`/projects/${project.id}`} className="-my-2 inline-block py-2 hover:text-ink">{project.name}</a></li><li aria-hidden>/</li></>}
          <li><a href={`/runs/${capture.runId}`} className="-my-2 inline-block py-2 hover:text-ink">{runTitle(capture.runNumber)}</a></li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="font-bold text-ink">Screen capture</li>
        </ol>
      </nav>
      <h1 className="text-2xl font-bold break-words">{title}</h1>
      <p className="mt-2 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Screen capture · {capture.replay ? "where the replay ended" : "when reported"}</p>
      <img
        src={`/api/artifacts/${capture.id}`}
        alt={capture.replay ? `The page where the replay of “${title}” ended` : `The page when “${title}” was reported`}
        width={1280}
        height={720}
        className="mt-4 block h-auto w-full border border-line"
      />
      <p className="mt-2 text-xs text-muted">Password fields are blacked out in screen captures.</p>
    </AppShell>
  );
}
