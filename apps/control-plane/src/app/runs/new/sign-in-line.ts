export type Person = { key: string; name: string; signs_in: boolean; account_ref: string | null };

export function signInLine(person: Person, accounts: Array<{ ref: string; username: string }>): { text: string; missing: boolean } {
  const account = accounts.find((a) => a.ref === person.account_ref);
  if (account) return { text: `Signs in as ${account.username}`, missing: false };
  if (person.signs_in || person.account_ref) return { text: "Needs a test account to sign in", missing: true };
  return { text: "Signs up as a new user", missing: false };
}
