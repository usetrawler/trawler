import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { screenCapture } from "../../../artifacts/artifacts.ts";
import { AppShell } from "../../../components/app-shell.tsx";
import { findingAnchor } from "../../../runs/finding-anchor.ts";
import { runPath, runTitle } from "../../../runs/status.ts";
import { signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { shellFor } from "../../../server/shell.ts";
import { capturePageTitle } from "../../../server/titles.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return capturePageTitle(await headers(), id);
}

export default async function CapturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const capture = await screenCapture(getDb(), member.orgId, id);
  if (!capture) notFound();
  const shell = await shellFor(member);
  const project = shell.workspace.projects.find((p) => p.id === capture.projectId);
  const title = capture.findingTitle ?? "Screen capture";
  const run = `${runPath(capture.runNumber)}${capture.findingKey ? `#${findingAnchor(capture.findingKey)}` : ""}`;
  return (
    <AppShell shell={shell} current={{ project: capture.projectId }} parent wide>
      <nav aria-label="Breadcrumb" className="mb-[34px]">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-4 font-mono text-[10px] text-muted">
          {project && <><li><a href={`/projects/${project.id}`} className="-my-2 inline-block py-2 hover:text-ink">{project.name}</a></li><li aria-hidden>/</li></>}
          <li><a href={run} className="-my-2 inline-block py-2 hover:text-ink">{runTitle(capture.runNumber)}</a></li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="font-bold text-ink">Screen capture</li>
        </ol>
      </nav>
      <h1 className="text-2xl font-bold break-words">{title}</h1>
      <p className="mt-2 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Screen capture · {capture.replay ? "where the replay ended" : "when reported"}</p>
      <a href={`/api/artifacts/${capture.id}`} target="_blank" rel="noreferrer" tabIndex={-1} className="mt-4 block max-w-[1282px]">
        <img
          src={`/api/artifacts/${capture.id}`}
          alt={capture.replay ? `The page where the replay of “${title}” ended` : `The page when “${title}” was reported`}
          width={1280}
          height={720}
          className="block h-auto w-full border border-line"
        />
        <span className="sr-only"> (opens the original in a new tab)</span>
      </a>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>Passwords and other secrets are blacked out in screen captures.</span>
        <a href={`/api/artifacts/${capture.id}`} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-4 hover:text-action-ink">
          Open the original, 1280 × 720<span aria-hidden="true"> ↗</span><span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>
    </AppShell>
  );
}
