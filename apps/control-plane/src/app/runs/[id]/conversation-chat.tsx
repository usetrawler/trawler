"use client";
import { useEffect, useState } from "react";
import { ClockTime } from "../../../components/local-time.tsx";
import { findingAnchor } from "../../../runs/finding-anchor.ts";
import type { RunSummary } from "../../../runs/runs.ts";
import { letterOf, toneOf, type PersonTone } from "./person-tones.ts";
import { handoffs, turnsOfPeople } from "./timeline-lanes.tsx";

const SHOWN = 8;

type Person = { id: string; name: string; tone: PersonTone };

export type ChatItem =
  | { kind: "message"; id: string; at: number; personaKey: string | null; text: string }
  | { kind: "goal"; id: string; at: number; personaKey: string | null; status: "reached" | "failed" | "not_attempted"; goal: string }
  | { kind: "finding"; id: string; at: number; personaKey: string | null; findingKey: string; findingKind: "defect" | "friction"; title: string; n: number }
  | { kind: "handoff"; id: string; at: number; from: string; to: string };

export function chatItems(run: RunSummary, now: number): ChatItem[] {
  const findingNumber = new Map(run.marks.filter((m) => m.kind === "finding").map((m, i) => [m.id, i + 1]));
  const items: ChatItem[] = [
    ...run.conversationMessages.map((m) => ({ kind: "message" as const, id: m.id, at: new Date(m.at).getTime(), personaKey: m.personaKey, text: m.text })),
    ...run.marks.flatMap((m): ChatItem[] => {
      if (m.jobKind !== "role_session") return [];
      if (m.kind === "goal") return [{ kind: "goal", id: m.id, at: new Date(m.at).getTime(), personaKey: m.personaKey, status: m.status, goal: m.goal }];
      if (m.kind === "finding") return [{ kind: "finding", id: m.id, at: new Date(m.at).getTime(), personaKey: m.personaKey, findingKey: m.findingKey, findingKind: m.findingKind, title: m.title, n: findingNumber.get(m.id)! }];
      return [];
    }),
    ...handoffs(turnsOfPeople(run.jobs, now)).map((h, i) => ({ kind: "handoff" as const, id: `handoff-${i}`, at: h.at, from: h.from, to: h.to })),
  ];
  return items.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function withMentions(text: string, people: Person[], speaker: string | null): React.ReactNode[] {
  const others = people.filter((p) => p.id !== speaker && p.name.trim());
  if (others.length === 0) return [text];
  const pattern = new RegExp(`(@?\\b(?:${others.map((p) => escapeRegExp(p.name.trim())).join("|")})\\b)`, "gi");
  return text.split(pattern).map((part, i) => {
    const named = others.find((p) => part.replace(/^@/, "").toLowerCase() === p.name.trim().toLowerCase());
    return named ? <span key={i} className="rounded-[5px] px-[3px] font-medium" style={{ color: named.tone.text, background: named.tone.tint }}>{part}</span> : part;
  });
}

function Avatar({ person }: { person: Person | undefined }) {
  return <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-full text-xs font-semibold" style={{ background: person?.tone.bar ?? "var(--soft)", color: person?.tone.onBar ?? "var(--muted)" }}>{letterOf(person?.name ?? "?")}</span>;
}

function EventLine({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[42px] text-sm text-muted before:h-px before:w-5 before:bg-line">{children}</li>;
}

export function ConversationChat({ run, live, now }: { run: RunSummary; live: boolean; now: number }) {
  const [all, setAll] = useState(false);
  const people: Person[] = run.personas.map((p, i) => ({ ...p, tone: toneOf(i) }));
  const person = (id: string | null) => people.find((p) => p.id === id);
  const items = chatItems(run, now);
  const messages = items.filter((i) => i.kind === "message");
  const firstShown = all ? 0 : Math.max(0, items.findIndex((i) => i === messages[Math.max(0, messages.length - SHOWN)]));
  const shown = items.slice(firstShown);
  const working = live ? run.jobs.find((j) => j.kind === "role_session" && j.status === "leased" && j.persona_key) : undefined;
  useEffect(() => {
    const showAddressed = () => {
      const id = window.location.hash.startsWith("#message-") ? window.location.hash.slice("#message-".length) : null;
      if (id && !shown.some((i) => i.kind === "message" && i.id === id) && messages.some((m) => m.id === id)) setAll(true);
    };
    showAddressed();
    window.addEventListener("hashchange", showAddressed);
    return () => window.removeEventListener("hashchange", showAddressed);
  });
  useEffect(() => {
    if (!all) return;
    const id = window.location.hash.slice(1);
    if (id.startsWith("message-")) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [all]);
  const minutes = messages.length > 1 ? Math.max(1, Math.round((messages.at(-1)!.at - messages[0]!.at) / 60_000)) : 0;
  return (
    <section aria-labelledby="conversation" className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="conversation" className="text-lg font-medium">Conversation</h2>
          <p className="text-sm text-muted">
            {messages.length === 0 ? "No one has said anything yet." : `${messages.length} ${messages.length === 1 ? "message" : "messages"}${minutes ? ` in ${minutes} ${minutes === 1 ? "minute" : "minutes"}` : ""}${live ? " so far · new ones appear as they are said" : ""}`}
          </p>
        </div>
        <span aria-hidden className="flex">{people.map((p) => <span key={p.id} className="-ml-1.5 grid size-[26px] place-items-center rounded-full text-xs font-semibold ring-2 ring-panel" style={{ background: p.tone.bar, color: p.tone.onBar }}>{letterOf(p.name)}</span>)}</span>
      </div>
      {(items.length > 0 || working) && (
        <ol className="flex flex-col gap-3.5" aria-live={live ? "polite" : undefined}>
          {!all && firstShown > 0 && (
            <li className="pl-[42px]"><button type="button" onClick={() => setAll(true)} className="text-sm text-muted underline underline-offset-4 hover:text-ink">Show the earlier {messages.length - Math.min(SHOWN, messages.length)} {messages.length - SHOWN === 1 ? "message" : "messages"}</button></li>
          )}
          {shown.map((item) => {
            if (item.kind === "message") {
              const who = person(item.personaKey);
              return (
                <li key={item.id} id={`message-${item.id}`} className="grid scroll-mt-24 grid-cols-[30px_minmax(0,1fr)] items-start gap-3">
                  <Avatar person={who} />
                  <div className="min-w-0 max-w-[36rem]">
                    <p className="flex items-baseline gap-2 text-[13px] text-muted"><b className="text-sm font-semibold" style={{ color: who?.tone.text }}>{who?.name ?? "Someone"}</b><ClockTime iso={new Date(item.at).toISOString()} /></p>
                    <p className="mt-1 rounded-[4px_16px_16px_16px] px-3.5 py-2.5 break-words" style={{ background: who?.tone.tint ?? "var(--soft)" }}>{withMentions(item.text, people, item.personaKey)}</p>
                  </div>
                </li>
              );
            }
            if (item.kind === "goal") {
              const who = person(item.personaKey);
              return (
                <EventLine key={item.id}>
                  <span aria-hidden className={item.status === "reached" ? "text-ok" : item.status === "failed" ? "text-bad" : ""}>{item.status === "reached" ? "✓" : item.status === "failed" ? "✕" : "·"}</span>
                  <span>{who?.name ?? "Someone"} {item.status === "reached" ? "reached" : item.status === "failed" ? "did not reach" : "left"}</span>
                  <span className="text-ink">{item.goal}</span>
                </EventLine>
              );
            }
            if (item.kind === "finding") {
              const who = person(item.personaKey);
              return (
                <EventLine key={item.id}>
                  <a href={`#${findingAnchor(item.findingKey)}`} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 hover:text-ink">
                    <span aria-hidden className="grid size-[22px] place-items-center rounded-md text-xs font-semibold text-ink shadow-[0_0_0_1.5px_var(--ink)]">{item.n}</span>
                    <span>{who?.name ?? "Someone"} {item.findingKind === "defect" ? "reported a defect" : "noted friction"}</span>
                    <span className="text-ink underline underline-offset-4">{item.title}</span>
                  </a>
                </EventLine>
              );
            }
            return <EventLine key={item.id}>{person(item.from)?.name ?? "Someone"} hands over to {person(item.to)?.name ?? "someone"}</EventLine>;
          })}
          {working && (() => {
            const who = person(working.persona_key);
            return (
              <li aria-live="off" className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-3">
                <Avatar person={who} />
                <div>
                  <p className="text-[13px]"><b className="text-sm font-semibold" style={{ color: who?.tone.text }}>{who?.name}</b> <span className="text-ok">is working · step {working.steps}</span></p>
                  <span aria-hidden className="mt-1 inline-flex gap-1 rounded-[4px_16px_16px_16px] px-3.5 py-3" style={{ background: who?.tone.tint }}>
                    {[0, 1, 2].map((i) => <i key={i} className="size-1.5 rounded-full motion-safe:animate-pulse" style={{ background: who?.tone.bar, animationDelay: `${i * 160}ms` }} />)}
                  </span>
                </div>
              </li>
            );
          })()}
        </ol>
      )}
    </section>
  );
}
