import type { ProductSummary } from "@usetrawler/core/setup";

export const WORKING_MINUTES = 5;

export type SetupProgress =
  | { state: "project"; projectId: string; planId?: string }
  | { state: "described"; summary: ProductSummary }
  | { state: "working" }
  | { state: "failed" }
  | { state: "gone" };
