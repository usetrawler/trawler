import type { Goal, GoalOutcome, Persona } from "@usetrawler/protocol";

export function rolePrompt(p: { persona: Persona; targetUrl: string; docsUrl?: string; goals: Goal[]; accountRef?: string }): string {
  const goalLines = p.goals.map((g, i) => `${i + 1}. [${g.id}] ${g.instruction}`).join("\n");
  const signIn = p.accountRef
    ? `You have an account "${p.accountRef}". To sign in, take a snapshot, then call sign_in with the account and the refs of the username and password fields. You will never see the password.`
    : "You have no account. If the product lets people sign up, sign up the way a new user would.";
  const docs = p.docsUrl ? ` Its documentation is at ${p.docsUrl}; read it if and when you would, in character.` : "";
  return `You are ${p.persona.name}. ${p.persona.brief}

You are trying a product you have never used, at ${p.targetUrl}.${docs}
${signIn}

Work through these goals in order, in the browser, actually trying each one:
${goalLines}

Every turn must call a tool; plain text does nothing.
Use browser_snapshot to see the page; actions such as clicking do not return the page. To act on an element, pass its ref from the latest snapshot (for example e12) as target. Older page results are removed from your view, so write anything you need to remember with note.
Do not give up on a goal the moment it is awkward, and do not keep going once you are convinced it cannot be done. Spend roughly fifteen steps per goal. After each goal call goal_status with reached or failed.

Record findings with submit_finding the moment you see them, not at the end.
A "defect" is a claim about the product: something behaved wrongly. Its reproduction must be literal enough that a stranger told nothing else can follow it on a fresh copy of the product and see the same thing: exact URLs, exact button labels, exact values typed. If you cannot write steps like that, it is not a defect.
"friction" is a claim about you: you could not find something, or it was not clear. Its reproduction is the path you actually took while confused. Do not dress friction up as a defect.
Report nothing you did not see in the browser. An opinion about the design is not a finding.

When every goal has a status, call finish.`;
}

export function sessionStatus(notes: string[], goals: GoalOutcome[], step: number, maxSteps: number): string {
  const pad = notes.length ? notes.map((n) => `- ${n}`).join("\n") : "(empty)";
  const table = goals.map((g) => `- ${g.goal}: ${g.status}${g.note ? ` — ${g.note}` : ""}`).join("\n");
  return `\n\n## Your scratchpad\n${pad}\n\n## Goal status\n${table}\n\nStep ${step + 1} of ${maxSteps}.`;
}
