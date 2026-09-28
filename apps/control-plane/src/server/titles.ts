import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { screenCapture } from "../artifacts/artifacts.ts";
import { withOrg } from "../db/tenancy.ts";
import { projectHead, runHead } from "../projects/overview.ts";
import { runTitle } from "../runs/status.ts";
import { signedInMember } from "./auth.ts";
import { getDb } from "./db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function projectPageTitle(requestHeaders: Headers, projectId: string, page: string): Promise<Metadata> {
  const member = await signedInMember(requestHeaders);
  if (!member) return {};
  if (!UUID.test(projectId)) notFound();
  const project = await withOrg(getDb(), member.orgId, (tx) => projectHead(tx, member.orgId, projectId));
  if (!project) notFound();
  return { title: `${project.name} · ${page}` };
}

export async function runPageTitle(requestHeaders: Headers, runId: string): Promise<Metadata> {
  const member = await signedInMember(requestHeaders);
  if (!member) return {};
  if (!UUID.test(runId)) notFound();
  const run = await withOrg(getDb(), member.orgId, (tx) => runHead(tx, member.orgId, runId));
  if (!run) notFound();
  return { title: `${runTitle(run.number)} · ${run.projectName}` };
}

export async function capturePageTitle(requestHeaders: Headers, captureId: string): Promise<Metadata> {
  const member = await signedInMember(requestHeaders);
  if (!member) return {};
  const capture = await screenCapture(getDb(), member.orgId, captureId);
  if (!capture) notFound();
  const project = await withOrg(getDb(), member.orgId, (tx) => projectHead(tx, member.orgId, capture.projectId));
  return { title: ["Screen capture", runTitle(capture.runNumber), project?.name].filter(Boolean).join(" · ") };
}
