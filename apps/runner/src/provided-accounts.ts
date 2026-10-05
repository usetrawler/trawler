import { providedAccountRef, type AccountsFile, type JobAssignment } from "@usetrawler/protocol";

export function withProvidedAccounts(job: JobAssignment, accounts: AccountsFile = {}): { job: JobAssignment } | { missing: string } {
  const provided = new Set(job.providedAccounts ?? []);
  const people = job.config.personas.filter((p) => !p.accountRef && provided.has(p.name));
  if (people.length === 0) return { job };
  const needed = job.kind === "role_session" ? people.filter((p) => p.id === job.personaKey) : job.kind === "replay" ? people : [];
  const missing = needed.find((p) => !Object.hasOwn(accounts, p.name));
  if (missing) return { missing: missing.name };
  const have = people.filter((p) => Object.hasOwn(accounts, p.name));
  const ref = new Map(have.map((p) => [p.id, providedAccountRef(p.id)]));
  return {
    job: {
      ...job,
      config: {
        ...job.config,
        personas: job.config.personas.map((p) => (ref.has(p.id) ? { ...p, accountRef: ref.get(p.id) } : p)),
        accounts: [...job.config.accounts, ...have.map((p) => ({ ref: ref.get(p.id)!, ...accounts[p.name]! }))],
      },
    },
  };
}
