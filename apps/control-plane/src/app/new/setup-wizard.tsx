"use client";
import { unstable_isUnrecognizedActionError, unstable_rethrow, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ProductSummary, SignUp } from "@usetrawler/core/setup";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { WORKING_MINUTES, type SetupProgress } from "../../setup/progress.ts";
import { describeProductAction, proposePeopleAction, readProductAction, setupProgressAction } from "./actions.ts";

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
  | { kind: "byHand"; host: string; name: string; description: string }
  | { kind: "working"; step: Step; host: string; checking?: boolean; byHand?: boolean }
  | { kind: "context"; draftId: string; host: string; description: string; signUp: SignUp; features: Feature[]; byHand?: boolean };

export const LOST = Symbol("the request did not come back");

export async function reached<T>(call: () => Promise<T>, redo: string): Promise<T | { ok: false; error: string } | typeof LOST> {
  try {
    return await call();
  } catch (err) {
    unstable_rethrow(err);
    if (unstable_isUnrecognizedActionError(err)) return { ok: false, error: updatedSinceOpened(redo) };
    return LOST;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ASK_EVERY_MS = 3000;
const TRIES = Math.ceil((WORKING_MINUTES * 60_000) / ASK_EVERY_MS) + 10;

export async function untilSettled(draftId: string, opts: { ask?: (draftId: string) => Promise<SetupProgress>; wait?: (ms: number) => Promise<unknown>; tries?: number; signal?: AbortSignal } = {}): Promise<SetupProgress | "unreachable" | "left"> {
  const ask = opts.ask ?? setupProgressAction;
  const wait = opts.wait ?? pause;
  for (let i = 0; i < (opts.tries ?? TRIES); i++) {
    await wait(ASK_EVERY_MS);
    if (opts.signal?.aborted) return "left";
    try {
      const progress = await ask(draftId);
      if (opts.signal?.aborted) return "left";
      if (progress.state !== "working") return progress;
    } catch {
      continue;
    }
  }
  return "unreachable";
}

export const LOST_MESSAGE = {
  read: "Trawler did not answer while reading the page. Check your connection and try again.",
  gone: "Trawler did not answer, and this setup was lost. Start again from the product's address.",
  failed: "Trawler's setup model could not write a plan this time. Start again from the product's address.",
  unreachable: "Trawler could not be reached for a few minutes. Check your connection and try again; a project that was already made is not made twice.",
  notChosen: "Trawler did not answer before it chose the people. Choose them again.",
};

type Settled = SetupProgress | "unreachable";

export function afterLostProposal(progress: Settled): { open: string } | { error: string; back: "context" | "address" } {
  if (progress === "unreachable") return { error: LOST_MESSAGE.unreachable, back: "context" };
  if (progress.state === "project") return { open: `/projects/${progress.projectId}${progress.planId ? `?plan=${progress.planId}` : ""}` };
  if (progress.state === "gone") return { error: LOST_MESSAGE.gone, back: "address" };
  return { error: LOST_MESSAGE.notChosen, back: "context" };
}

export function afterLostDescription(progress: Settled): { summary: ProductSummary } | { error: string } {
  if (progress !== "unreachable" && progress.state === "described") return { summary: progress.summary };
  if (progress === "unreachable") return { error: LOST_MESSAGE.unreachable };
  return { error: progress.state === "failed" ? LOST_MESSAGE.failed : LOST_MESSAGE.gone };
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

function Working() {
  return (
    <span aria-hidden className="relative grid h-24 w-24 place-items-center self-center">
      <span className="absolute inset-0 rounded-full border border-action/40" />
      <span className="absolute inset-4 rounded-full border border-line" />
      <span className="absolute inset-0 motion-safe:animate-spin [animation-duration:2.4s]">
        <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-action" />
      </span>
      <span className="absolute h-5 w-5 rounded-full bg-action/40 motion-safe:animate-ping" />
      <span className="h-5 w-5 rounded-full bg-action" />
    </span>
  );
}

const BY_HAND_STEPS: typeof STEPS = [
  { step: "describe", title: "What the product does", working: "", done: "Written by you" },
  STEPS.find((s) => s.step === "propose")!,
];

export function Progress({ step, host, checking = false, byHand = false }: { step: Step; host: string; checking?: boolean; byHand?: boolean }) {
  const steps = byHand ? BY_HAND_STEPS : STEPS;
  const at = steps.findIndex((s) => s.step === step);
  return (
    <div role="status" className="flex flex-col gap-6">
      <Working />
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.2em] text-action-ink uppercase">Building your test plan</p>
        <h2 className="text-3xl leading-tight font-bold tracking-tight break-words md:text-5xl">Understanding {host}</h2>
        <p className="max-w-xl text-muted">{byHand ? "Trawler chooses people with different roles and goals from your description." : "Trawler reads the product's page, works out what it does, and then chooses people with different roles and goals."} This usually takes 1–2 minutes; keep this page open.</p>
        {checking && <p className="max-w-xl text-sm text-muted">Trawler did not answer. Checking whether setup finished…</p>}
      </div>
      <ol className="flex flex-col border-t border-line">
        {steps.map((s, i) => (
          <li key={s.step} aria-current={i === at ? "step" : undefined} className="flex items-start gap-3 border-b border-line py-3">
            <span aria-hidden className="grid h-5 w-4 place-items-center font-mono text-sm">
              {i < at ? <span className="text-ok">✓</span> : i === at ? <span className="h-3.5 w-3.5 rounded-full border-2 border-action border-t-transparent motion-safe:animate-spin" /> : <span className="text-muted">·</span>}
            </span>
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

export function SetupWizard({ intro, projectId, planId, newPlanName, projectHost, chosenBefore = [], initialDescription }: { intro?: React.ReactNode; projectId?: string; planId?: string; newPlanName?: string; projectHost?: string; chosenBefore?: string[]; initialDescription?: string }) {
  const [stage, setStage] = useState<Stage>({ kind: "address" });
  const [url, setUrl] = useState("");
  const [extra, setExtra] = useState("");
  const [planName, setPlanName] = useState(newPlanName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const polling = useRef<AbortController | null>(null);
  useEffect(() => () => polling.current?.abort(), []);
  const settle = async (draftId: string, step: Step, host: string, byHand = false) => {
    polling.current?.abort();
    const controller = new AbortController();
    polling.current = controller;
    setStage({ kind: "working", step, host, checking: true, byHand });
    return untilSettled(draftId, { signal: controller.signal });
  };

  const analyse = () => {
    const host = projectHost ?? hostOf(url);
    if (newPlanName !== undefined && !planName.trim()) return setError("Give the plan a name.");
    setError(null);
    setStage({ kind: "working", step: "read", host });
    start(() => describe(host));
  };
  const describe = async (host: string) => {
    const read = await reached(() => readProductAction(projectId ? { projectId, ...(planId ? { planId } : {}), ...(newPlanName !== undefined ? { planName } : {}) } : { url }), "Reload the page to analyse the product.");
    if (read === LOST) return (setError(LOST_MESSAGE.read), setStage({ kind: "address" }));
    if (!read.ok && "privateAddress" in read) return (setError(null), setStage({ kind: "byHand", host, name: "", description: "" }));
    if (!read.ok) return (setError(read.error), setStage({ kind: "address" }));
    setStage({ kind: "working", step: "describe", host });
    const described = await reached(() => describeProductAction(read.draftId), "Reload the page to analyse the product.");
    let summary: ProductSummary;
    if (described === LOST) {
      const settled = await settle(read.draftId, "describe", host);
      if (settled === "left") return;
      const after = afterLostDescription(settled);
      if ("error" in after) return (setError(after.error), setStage({ kind: "address" }));
      summary = after.summary;
    } else if (!described.ok) {
      return (setError(described.error), setStage({ kind: "address" }));
    } else {
      summary = described.summary;
    }
    setStage({ kind: "context", draftId: read.draftId, host, description: initialDescription || summary.description, signUp: summary.signUp, features: featuresFrom(summary, chosenBefore) });
  };

  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || newPlanName !== undefined || startedFor.current === projectId) return;
    startedFor.current = projectId;
    analyse();
  });

  if (stage.kind === "address" && projectId) {
    return (
      <div className="flex flex-col gap-4">
        {intro}
        {newPlanName !== undefined ? (
          <>
            <label className="flex max-w-xl flex-col gap-2">
              <span className="text-sm text-muted">Plan name</span>
              <input
                name="planName" type="text" maxLength={100} value={planName} onChange={(e) => setPlanName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); analyse(); } }}
                className="h-12 border border-line bg-soft px-4 text-base outline-none focus:border-ink"
              />
            </label>
            <p className="max-w-xl text-muted">Trawler reads {projectHost} again, lists what the product does, and proposes people for the features you choose. They go into a new plan with no test accounts; your other plans stay as they are.</p>
          </>
        ) : (
          <p className="max-w-xl text-muted">Trawler reads {projectHost} again, lists what the product does, and proposes people for the features you choose. Proposing replaces the people and goals on the plan. Test accounts stay; check who signs in with them afterwards.</p>
        )}
        {error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
        <button type="button" onClick={analyse} disabled={pending} className="flex h-12 items-center justify-between gap-6 self-start bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-70">
          {newPlanName !== undefined ? "Read the product" : "Read the product again"} <span aria-hidden>→</span>
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

  if (stage.kind === "byHand") {
    const typed = stage;
    const describeByHand = () => {
      setError(null);
      start(async () => {
        const read = await reached(() => readProductAction({ url, byHand: { name: typed.name, description: typed.description } }), "Reload the page to set up the product.");
        if (read === LOST) return setError(LOST_MESSAGE.read);
        if (!read.ok) return setError(read.error);
        setStage({ kind: "context", draftId: read.draftId, host: typed.host, description: typed.description.trim(), signUp: "unclear", features: [], byHand: true });
      });
    };
    return (
      <form className="flex flex-col gap-6" onSubmit={(e) => { e.preventDefault(); describeByHand(); }}>
        <div className="flex flex-col gap-3">
          <p className="font-mono text-xs tracking-[0.2em] text-action-ink uppercase">{typed.host} is on a private network</p>
          <h2 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">Describe it yourself.</h2>
          <p className="max-w-xl text-lg text-muted">Trawler cannot read a page that only your network or a CI job can reach, so tell it what the product is. The people still use it at {typed.host}, through a runner that can reach it.</p>
        </div>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Product name</span>
          <input name="name" type="text" required maxLength={200} value={typed.name} onChange={(e) => setStage({ ...typed, name: e.target.value })} className="h-12 border border-line bg-soft px-4 text-base outline-none focus:border-ink" />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">What it does and who it is for</span>
          <textarea name="description" required maxLength={2000} rows={4} value={typed.description} onChange={(e) => setStage({ ...typed, description: e.target.value })} className="resize-y border border-line bg-soft p-4 text-base outline-none focus:border-ink" />
        </label>
        {error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
          <button type="button" onClick={() => { setError(null); setStage({ kind: "address" }); }} className="text-sm text-muted hover:text-ink">← Back</button>
          <button type="submit" disabled={pending} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-70">
            Choose the features <span aria-hidden>→</span>
          </button>
        </div>
      </form>
    );
  }

  if (stage.kind === "working") return <Progress step={stage.step} host={stage.host} checking={stage.checking} byHand={stage.byHand} />;

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
    setStage({ kind: "working", step: "propose", host: stage.host, byHand: stage.byHand });
    start(async () => {
      const res = await reached(() => proposePeopleAction({ draftId: context.draftId, description: context.description, signUp: context.signUp, features: context.features.filter((f) => f.chosen).map((f) => f.title) }), "Reload the page and start again.");
      if (res === LOST) {
        const settled = await settle(context.draftId, "propose", context.host, context.byHand);
        if (settled === "left") return;
        const after = afterLostProposal(settled);
        if ("open" in after) return router.push(after.open);
        setError(after.error);
        return setStage(after.back === "context" ? context : { kind: "address" });
      }
      if (res && !res.ok) {
        setError(res.error);
        setStage(context);
      }
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.2em] text-action-ink uppercase">{stage.byHand ? "Your description" : "Trawler understood the product"}</p>
        <h2 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">Confirm the context.</h2>
        <p className="max-w-xl text-lg text-muted">{stage.byHand ? "We use this only to choose the people and their goals." : "We use this only to choose the people and their goals. Edit it if we misunderstood anything."}</p>
      </div>
      <label className="flex flex-col border border-line bg-panel">
        <span className="flex items-center justify-between border-b border-line px-4 py-2 font-mono text-[11px] tracking-[0.15em] uppercase">
          <span>Product context</span><span className="text-ok">{stage.byHand ? "Written by you · editable" : "AI draft · editable"}</span>
        </span>
        <textarea aria-label="What the product does" value={stage.description} maxLength={2000} rows={4} onChange={(e) => update({ description: e.target.value })} className="resize-y bg-transparent p-4 text-lg outline-none focus:bg-paper" />
      </label>
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm">Can new people create an account themselves?</span>
          <select aria-describedby="sign-up-note" value={stage.signUp} onChange={(e) => update({ signUp: e.target.value as SignUp })} className="h-11 border border-line bg-soft px-3 outline-none focus:border-ink">
            <option value="open">Yes, anyone can sign up</option>
            <option value="closed">No, accounts come from an invitation or an admin</option>
            <option value="unclear">Not sure</option>
          </select>
        </label>
        <p id="sign-up-note" className="text-xs text-muted">{stage.byHand && stage.signUp === "unclear" ? "Setup decides per person; you can change it on the plan." : SIGN_UP_NOTE[stage.signUp]}</p>
      </div>
      <section className="flex flex-col gap-3" aria-labelledby="features-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h3 id="features-heading" className="text-xl font-bold">What should the people try?</h3>
            <p className="text-sm text-muted">{stage.byHand ? "Add each feature the people should try." : "We preselected the best match."}</p>
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
                <span aria-hidden className={f.chosen ? "text-action-ink" : "text-muted"}>{f.chosen ? "✓" : "+"}</span>
              </button>
            </li>
          ))}
        </ul>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addExtra(); }}>
          <input aria-label="Describe another feature" placeholder="Or describe another feature" value={extra} maxLength={300} onChange={(e) => setExtra(e.target.value)} className="h-11 flex-1 border border-line bg-soft px-3 outline-none focus:border-ink" />
          <button type="submit" className="h-11 border border-ink px-4 font-mono text-xs tracking-[0.12em] uppercase">Add</button>
        </form>
      </section>
      {projectId && <p className="text-sm text-muted">{newPlanName !== undefined ? `This creates the plan ${planName.trim()} with these people and goals. Your other plans stay as they are.` : "Proposing replaces the people and goals on the plan. Test accounts stay; check who signs in with them afterwards."}</p>}
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
