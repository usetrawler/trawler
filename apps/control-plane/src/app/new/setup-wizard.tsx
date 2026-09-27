"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ProductSummary, SignUp } from "@usetrawler/core/setup";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { describeProductAction, proposePeopleAction, readProductAction } from "./actions.ts";

const MAX_CHOSEN = 10;

type Step = "read" | "describe" | "propose";
const STEPS: { step: Step; title: string; working: string; done: string }[] = [
  { step: "read", title: "The page", working: "Reading the page…", done: "Read" },
  { step: "describe", title: "What the product does", working: "Finding what the product does…", done: "Understood" },
  { step: "propose", title: "People to try it", working: "Choosing people with different roles and goals…", done: "Ready" },
];

const SIGN_UP_NOTE: Record<SignUp, string> = {
  open: "People whose role anyone can have sign up; roles such as a reviewer or an administrator sign in with a test account.",
  closed: "Everyone signs in with a test account, which you add on the plan before the run starts.",
  unclear: "Trawler could not tell from the page. Setup decides per person; you can change it on the plan.",
};

type Feature = { title: string; summary: string; chosen: boolean };
type Stage =
  | { kind: "address" }
  | { kind: "working"; step: Step; host: string }
  | { kind: "context"; draftId: string; host: string; description: string; signUp: SignUp; features: Feature[] };

async function outdatedAware<T>(call: () => Promise<T>, redo: string): Promise<T | { ok: false; error: string }> {
  try {
    return await call();
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { ok: false, error: updatedSinceOpened(redo) };
  }
}

function hostOf(raw: string): string {
  const trimmed = raw.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).host;
  } catch {
    return trimmed;
  }
}

export function featuresFrom(summary: ProductSummary, chosenBefore: string[] = []): Feature[] {
  const before = new Set(chosenBefore.map((f) => f.toLowerCase()));
  const offered = summary.features.map((f, i) => ({ ...f, chosen: chosenBefore.length ? before.has(f.title.toLowerCase()) : i === 0 }));
  const kept = chosenBefore.filter((f) => !offered.some((o) => o.title.toLowerCase() === f.toLowerCase())).map((title) => ({ title, summary: "", chosen: true }));
  return [...offered, ...kept];
}

function Progress({ step, host }: { step: Step; host: string }) {
  const at = STEPS.findIndex((s) => s.step === step);
  return (
    <div role="status" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">Building your test plan</p>
        <h2 className="text-3xl leading-tight font-bold tracking-tight break-words md:text-5xl">Understanding {host}</h2>
        <p className="max-w-xl text-muted">Trawler reads the product&apos;s page, works out what it does, and then chooses people with different roles and goals. Each step takes a few seconds to a minute.</p>
      </div>
      <ol className="flex flex-col border-t border-line">
        {STEPS.map((s, i) => (
          <li key={s.step} className="flex items-start gap-3 border-b border-line py-3">
            <span aria-hidden className={`w-4 pt-0.5 font-mono text-sm ${i < at ? "text-ok" : i === at ? "text-action" : "text-muted"}`}>{i < at ? "✓" : i === at ? "○" : "·"}</span>
            <span className="flex flex-col">
              <strong className="text-sm">{s.title}</strong>
              <span className="text-xs text-muted">{i < at ? s.done : i === at ? s.working : "Waiting"}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function SetupWizard({ intro, projectId, projectHost, chosenBefore = [], initialDescription }: { intro?: React.ReactNode; projectId?: string; projectHost?: string; chosenBefore?: string[]; initialDescription?: string }) {
  const [stage, setStage] = useState<Stage>({ kind: "address" });
  const [url, setUrl] = useState("");
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const analyse = () => {
    const host = projectHost ?? hostOf(url);
    setError(null);
    setStage({ kind: "working", step: "read", host });
    start(() => describe(host));
  };
  const describe = async (host: string) => {
    const read = await outdatedAware(() => readProductAction(projectId ? { projectId } : { url }), "Reload the page to analyse the product.");
    if (!read.ok) return (setError(read.error), setStage({ kind: "address" }));
    setStage({ kind: "working", step: "describe", host });
    const described = await outdatedAware(() => describeProductAction(read.draftId), "Reload the page to analyse the product.");
    if (!described.ok) return (setError(described.error), setStage({ kind: "address" }));
    const summary = described.summary;
    setStage({ kind: "context", draftId: read.draftId, host, description: initialDescription || summary.description, signUp: summary.signUp, features: featuresFrom(summary, chosenBefore) });
  };

  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || startedFor.current === projectId) return;
    startedFor.current = projectId;
    analyse();
  });

  if (stage.kind === "address" && projectId) {
    return (
      <div className="flex flex-col gap-4">
        {intro}
        <p className="max-w-xl text-muted">Trawler reads {projectHost} again, lists what the product does, and proposes people for the features you choose. Proposing replaces the people and goals on the plan. Test accounts stay; check who signs in with them afterwards.</p>
        {error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
        <button type="button" onClick={analyse} disabled={pending} className="flex h-12 items-center justify-between gap-6 self-start bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-70">
          Read the product again <span aria-hidden>→</span>
        </button>
      </div>
    );
  }

  if (stage.kind === "address") {
    return (
      <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); analyse(); }}>
        {intro}
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Product URL</span>
          <input
            name="url" type="text" inputMode="url" autoComplete="url" required value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://app.example.com"
            className="h-14 border border-line bg-soft px-4 font-mono text-base outline-none focus:border-ink"
          />
        </label>
        {error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
        <div className="flex flex-col-reverse items-stretch justify-between gap-4 border-t border-line pt-6 sm:flex-row sm:items-center">
          <p className="text-sm text-muted">Next: confirm what the product does and which features to try.</p>
          <button type="submit" disabled={pending} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-70">
            Analyse product <span aria-hidden>→</span>
          </button>
        </div>
      </form>
    );
  }

  if (stage.kind === "working") return <Progress step={stage.step} host={stage.host} />;

  const chosen = stage.features.filter((f) => f.chosen);
  const update = (patch: Partial<Extract<Stage, { kind: "context" }>>) => setStage({ ...stage, ...patch });
  const toggle = (i: number) => update({ features: stage.features.map((f, j) => (j === i ? { ...f, chosen: !f.chosen } : f)) });
  const addExtra = () => {
    const title = extra.trim();
    if (!title || chosen.length >= MAX_CHOSEN) return;
    const existing = stage.features.findIndex((f) => f.title.toLowerCase() === title.toLowerCase());
    update({ features: existing >= 0 ? stage.features.map((f, j) => (j === existing ? { ...f, chosen: true } : f)) : [...stage.features, { title, summary: "", chosen: true }] });
    setExtra("");
  };
  const propose = () => {
    setError(null);
    const context = stage;
    setStage({ kind: "working", step: "propose", host: stage.host });
    start(async () => {
      const res = await outdatedAware(() => proposePeopleAction({ draftId: context.draftId, description: context.description, signUp: context.signUp, features: context.features.filter((f) => f.chosen).map((f) => f.title) }), "Reload the page and start again.");
      if (res && !res.ok) {
        setError(res.error);
        setStage(context);
      }
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">Trawler understood the product</p>
        <h2 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">Confirm the context.</h2>
        <p className="max-w-xl text-lg text-muted">We use this only to choose the people and their goals. Edit it if we misunderstood anything.</p>
      </div>
      <label className="flex flex-col border border-line bg-panel">
        <span className="flex items-center justify-between border-b border-line px-4 py-2 font-mono text-[11px] tracking-[0.15em] uppercase">
          <span>Product context</span><span className="text-ok">AI draft · editable</span>
        </span>
        <textarea aria-label="What the product does" value={stage.description} maxLength={2000} rows={4} onChange={(e) => update({ description: e.target.value })} className="resize-y bg-transparent p-4 text-lg outline-none focus:bg-paper" />
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-sm">Can new people create an account themselves?</span>
        <select value={stage.signUp} onChange={(e) => update({ signUp: e.target.value as SignUp })} className="h-11 border border-line bg-soft px-3 outline-none focus:border-ink">
          <option value="open">Yes, anyone can sign up</option>
          <option value="closed">No, accounts come from an invitation or an admin</option>
          <option value="unclear">Not sure</option>
        </select>
        <span className="text-xs text-muted">{SIGN_UP_NOTE[stage.signUp]}</span>
      </label>
      <section className="flex flex-col gap-3" aria-labelledby="features-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3 id="features-heading" className="text-xl font-bold">What should the people try?</h3>
            <p className="text-sm text-muted">We preselected the best match.</p>
          </div>
          <p className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Select one or more</p>
        </div>
        <ul className="flex flex-col gap-2">
          {stage.features.map((f, i) => (
            <li key={`${i}-${f.title}`}>
              <button type="button" aria-pressed={f.chosen} onClick={() => toggle(i)} disabled={!f.chosen && chosen.length >= MAX_CHOSEN} className={`flex w-full items-center gap-4 border px-4 py-3 text-left transition ${f.chosen ? "border-action bg-action/10" : "border-line bg-panel hover:border-ink"}`}>
                <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex flex-1 flex-col">
                  <strong>{f.title}</strong>
                  {f.summary && <span className="text-sm text-muted">{f.summary}</span>}
                </span>
                <span aria-hidden className={f.chosen ? "text-action" : "text-muted"}>{f.chosen ? "✓" : "+"}</span>
              </button>
            </li>
          ))}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addExtra(); }}>
          <input aria-label="Describe another feature" placeholder="Or describe another feature" value={extra} maxLength={300} onChange={(e) => setExtra(e.target.value)} className="h-11 flex-1 border border-line bg-soft px-3 outline-none focus:border-ink" />
          <button type="submit" className="h-11 border border-ink px-4 font-mono text-xs tracking-[0.12em] uppercase">Add</button>
        </form>
      </section>
      {projectId && <p className="text-sm text-muted">Proposing replaces the people and goals on the plan. Test accounts stay; check who signs in with them afterwards.</p>}
      {error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
        <button type="button" onClick={() => { setError(null); setStage({ kind: "address" }); }} className="text-sm text-muted hover:text-ink">← Back</button>
        <span className="text-sm text-muted">{chosen.length === 1 ? "1 feature selected" : `${chosen.length} features selected`}</span>
        <button type="button" onClick={propose} disabled={pending || chosen.length === 0} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-60">
          Meet the test users <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  );
}
