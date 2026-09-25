import { readEnv } from "./env.ts";

export function betaRefusal(email: string): string | null {
  const beta = readEnv().betaEmails;
  return beta && !beta.includes(email.toLowerCase()) ? "Hosted runs are in private beta. Write to contact@usetrawler.com to get access." : null;
}
