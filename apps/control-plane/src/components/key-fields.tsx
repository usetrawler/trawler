"use client";
import { useId, type ReactNode } from "react";
import { PROVIDER_LABEL, providerArticle, type Provider } from "../llm/provider-kinds.ts";

export const field = "h-12 min-w-0 border border-line bg-soft px-4 font-mono text-sm outline-none focus:border-ink";

export function Recognised({ provider }: { provider: Provider }) {
  return <p className="text-sm"><span className="text-muted">Recognised as {providerArticle(provider)} </span>{PROVIDER_LABEL[provider]}<span className="text-muted"> key. Not right? Pick the provider below.</span></p>;
}

export function KeyFields({ apiKey, onKey, detected, chosen, onChoose, provider, baseUrl, onBaseUrl, required, aside, autoFocus }: {
  apiKey: string; onKey: (key: string) => void; detected: Provider | null; chosen: Provider | null; onChoose: (provider: Provider) => void;
  provider: Provider | null; baseUrl: string; onBaseUrl: (url: string) => void; required: boolean; aside?: ReactNode; autoFocus?: boolean;
}) {
  const keyId = useId();
  const label = provider && provider !== "custom" ? PROVIDER_LABEL[provider] : null;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={keyId} className="text-sm text-muted">
        An API key from your model provider: OpenAI, Anthropic, Google, OpenRouter or any OpenAI-compatible service. Runs are billed to it directly; Trawler adds nothing. It is stored encrypted and only its last characters are shown.
      </label>
      <div className="flex gap-2">
        <input id={keyId} name="apiKey" type="password" autoComplete="off" spellCheck={false} required={required} autoFocus={autoFocus} placeholder="sk-…, sk-ant-…, AIza…, sk-or-…" value={apiKey} onChange={(e) => onKey(e.target.value)} className={`${field} flex-1`} />
        {aside}
      </div>
      {detected && !chosen && <Recognised provider={detected} />}
      {apiKey.trim().length >= 20 && (
        <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
          <select name="provider" value={provider ?? "custom"} onChange={(e) => onChoose(e.target.value as Provider)} aria-label="Provider" className={field}>
            <option value="custom">OpenAI-compatible</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="google">Google</option>
            <option value="openrouter">OpenRouter</option>
          </select>
          {provider === "custom" && <input name="baseUrl" type="url" placeholder="https://api.example.com/v1" aria-label="Base URL" value={baseUrl} onChange={(e) => onBaseUrl(e.target.value)} className={field} />}
        </div>
      )}
      {provider && provider !== "openrouter" && <p className="text-xs text-muted">Calls go straight to {label ?? "that service"}, under its own data policy. Through OpenRouter, Trawler asks providers not to keep or train on your data.</p>}
    </div>
  );
}
