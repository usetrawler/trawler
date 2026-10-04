import { generic } from "./generic.ts";
import { github } from "./github.ts";
import type { CiAdapter, Env } from "./types.ts";

export const adapters: CiAdapter[] = [github];

export const detectAdapter = (env: Env): CiAdapter => adapters.find((a) => a.detect(env)) ?? generic;
