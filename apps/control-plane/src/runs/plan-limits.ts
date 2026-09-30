import { MAX_PERSONAS } from "@usetrawler/protocol";

export type WorkspacePlanName = "free" | "team" | "enterprise";

export interface PlanLimits {
  projects: number;
  runsPerDay: number;
  people: number;
}

export interface WorkspacePlan {
  plan: WorkspacePlanName;
  limits: PlanLimits;
}

export const PLAN_LABEL: Record<WorkspacePlanName, string> = { free: "Free", team: "Team", enterprise: "Enterprise" };

export const PLAN_LIMITS: Record<WorkspacePlanName, PlanLimits> = {
  free: { projects: 1, runsPerDay: 3, people: 4 },
  team: { projects: 3, runsPerDay: 30, people: MAX_PERSONAS },
  enterprise: { projects: Infinity, runsPerDay: Infinity, people: MAX_PERSONAS },
};

const CONTACT = "contact@usetrawler.com";

const moreOn = (plan: WorkspacePlanName) => (plan === "free" ? `write to ${CONTACT} about the Team plan` : `write to ${CONTACT} to raise it`);
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function projectLimitMessage({ plan, limits }: WorkspacePlan, projects: number): string {
  return `The ${PLAN_LABEL[plan]} plan includes ${counted(limits.projects, "project", "projects")}, and this workspace has ${counted(projects, "project", "projects")} already. Plan new runs on the one you have, test other products on your own machine with the local runner, or ${moreOn(plan)}.`;
}

export function runsPerDayMessage({ plan, limits }: WorkspacePlan): string {
  return `The ${PLAN_LABEL[plan]} plan includes ${counted(limits.runsPerDay, "hosted run", "hosted runs")} a day, and this workspace has started them all today. Try again after midnight UTC, run it on your own machine with the local runner, or ${moreOn(plan)}.`;
}

export function peopleLimitMessage({ plan, limits }: WorkspacePlan, people: number): string {
  return `The ${PLAN_LABEL[plan]} plan takes up to ${limits.people} people in a run, and this plan has ${people}. Remove people from the plan, run it on your own machine with the local runner, or ${moreOn(plan)}.`;
}
