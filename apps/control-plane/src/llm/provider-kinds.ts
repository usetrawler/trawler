export const PROVIDERS = ["openrouter", "openai", "anthropic", "google", "custom"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic", google: "Google", custom: "OpenAI-compatible" };

export const providerArticle = (provider: Provider) => (/^[AEIOU]/.test(PROVIDER_LABEL[provider]) ? "an" : "a");

export function detectProvider(key: string): Exclude<Provider, "custom"> | null {
  const k = key.trim();
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("AIza")) return "google";
  if (k.startsWith("sk-")) return "openai";
  return null;
}
