import type { GoalBlocker } from "@usetrawler/protocol";

export type GoalCause = GoalBlocker | "other";
export type UncheckedCause = Exclude<GoalCause, "product">;

export interface Coverage {
  total: number;
  checked: number;
  reached: number;
  notChecked: Record<UncheckedCause, number>;
  failedOnProduct: number;
  unchecked: Array<{ goal: string; cause: UncheckedCause }>;
}

export function causeOf(g: { status: string | null; blockedBy: GoalBlocker | null }): GoalCause | null {
  if (g.status === "reached") return null;
  return g.status === "failed" && g.blockedBy ? g.blockedBy : "other";
}

export function coverageOf(goals: Array<{ goal: string; status: string | null; blockedBy: GoalBlocker | null }>): Coverage {
  const c: Coverage = { total: goals.length, checked: 0, reached: 0, notChecked: { setup: 0, person: 0, other: 0 }, failedOnProduct: 0, unchecked: [] };
  for (const g of goals) {
    const cause = causeOf(g);
    if (cause === null) c.reached++;
    else if (cause === "product") c.failedOnProduct++;
    else {
      c.notChecked[cause]++;
      c.unchecked.push({ goal: g.goal, cause });
    }
  }
  c.checked = c.reached + c.failedOnProduct;
  return c;
}

const NOT_CHECKED_BECAUSE: Record<UncheckedCause, (n: number) => string> = {
  setup: (n) => `${n} because the setup lacked what ${n === 1 ? "it" : "they"} needed`,
  person: (n) => `${n} because a person could not find the way`,
  other: (n) => `${n} not finished`,
};

export function notCheckedParts(c: Pick<Coverage, "notChecked">): string[] {
  return (["setup", "person", "other"] as const).filter((k) => c.notChecked[k] > 0).map((k) => NOT_CHECKED_BECAUSE[k](c.notChecked[k]));
}

export function checkedLine(c: Pick<Coverage, "reached" | "failedOnProduct" | "notChecked" | "checked">, total: number, goals: (n: number) => string): string {
  const outcome = [`${c.reached} reached`, ...(c.failedOnProduct > 0 ? [`${c.failedOnProduct} failed on the product`] : [])].join(", ");
  const missing = notCheckedParts(c);
  return `${c.checked} of ${goals(total)} checked: ${outcome}.${missing.length > 0 ? ` Not checked: ${missing.join(", ")}.` : ""}`;
}
