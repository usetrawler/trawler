import { sql } from "kysely";
import { ProjectConfigSchema, type ProjectConfig } from "@usetrawler/protocol";
import type { Tx } from "../db/tenancy.ts";
import type { Keyring } from "../lib/secrets.ts";
import { createProject } from "./projects.ts";

export const DEMO_FEATURES = ["Search the shop", "Cart and discount code", "Checkout", "Order history", "Account"];

export function demoPlan(demoUrl: string): ProjectConfig {
  return ProjectConfigSchema.parse({
    name: "Greenhouse (demo)",
    targetUrl: new URL("/sign-in", demoUrl).toString(),
    description: "Greenhouse is a small online plant shop. People sign in, search and browse plants by category, put them in a cart, use a discount code, check out with a delivery address, look back at their orders and change their account details.",
    personas: [
      { id: "ana", name: "Ana", brief: "Buying her first houseplant for her flat in London. She shops on her phone in the evening, types the way she talks, and wants something hard to kill.", accountRef: "ana" },
      { id: "lee", name: "Lee", brief: "Furnishing a new flat on a budget. Buys several plants at once, compares prices and checks every total before paying.", accountRef: "lee" },
      { id: "sam", name: "Sam", brief: "Lives in Berlin and buys a few plants for his balcony. Likes to be sure an order really went through, and keeps his account details tidy.", accountRef: "sam" },
    ],
    goals: [
      { id: "find-a-fern", personaId: "ana", instruction: "Find a fern by searching for it, and put one in your cart." },
      { id: "first-order", personaId: "ana", instruction: "Use the shop's welcome code and pay less for your first order, delivered to your own address." },
      { id: "change-mind", personaId: "lee", instruction: "Put three different plants in your cart, then change your mind about one of them and take it out, keeping the others." },
      { id: "right-total", personaId: "lee", instruction: "Change how many you want of one of the plants in your cart, and make sure the total you would pay is right." },
      { id: "order-history", personaId: "sam", instruction: "Place an order and then find it among your past orders." },
      { id: "greeting", personaId: "sam", instruction: "Change the name the shop greets you with." },
    ],
    accounts: [
      { ref: "ana", username: "ana@greenhouse.test", password: "greenhouse-ana-2026" },
      { ref: "lee", username: "lee@greenhouse.test", password: "greenhouse-lee-2026" },
      { ref: "sam", username: "sam@greenhouse.test", password: "greenhouse-sam-2026" },
    ],
  });
}

export async function demoProject(tx: Tx, orgId: string, demoUrl: string, keys: Keyring): Promise<string> {
  const plan = demoPlan(demoUrl);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`demo:${orgId}`}, 0))`.execute(tx);
  const existing = await tx.selectFrom("projects").select("id").where("org_id", "=", orgId).where("target_url", "=", plan.targetUrl).where("name", "=", plan.name).orderBy("created_at").executeTakeFirst();
  return existing?.id ?? createProject(tx, orgId, plan, keys, { features: DEMO_FEATURES });
}
