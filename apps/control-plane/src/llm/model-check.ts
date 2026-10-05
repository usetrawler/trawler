import { checkModelCall, PROVIDER_LABEL, type Endpoint } from "./providers.ts";

export interface ModelCheckRefusal {
  error: string;
  field?: "key";
  reason: "key" | "model" | "unavailable";
}

export async function modelCheckRefusal(endpoint: Endpoint, modelId: string, check: typeof checkModelCall = checkModelCall): Promise<ModelCheckRefusal | null> {
  const result = await check(endpoint, modelId);
  if (result.ok) return null;
  const label = PROVIDER_LABEL[endpoint.provider];
  const detail = result.detail ? ` (${result.detail})` : "";
  if (result.reason === "key") return { error: `${label} did not accept this key${detail}.`, field: "key", reason: "key" };
  if (result.reason === "model") return { error: `This key cannot use ${modelId}${detail}. Pick another model.`, reason: "model" };
  return { error: `${label} could not be reached to check the key. Try again in a moment.`, reason: "unavailable" };
}
