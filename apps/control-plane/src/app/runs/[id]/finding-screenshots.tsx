"use client";
import { useState } from "react";

export type Shot = { id: string; caption: string; alt: string };

export function CaptureFrame({ shot, failed, onFailed }: { shot: Shot; failed: boolean; onFailed: () => void }) {
  const failedBeforeHydration = (img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth === 0) onFailed();
  };
  return (
    <figure className="row-span-2 grid min-w-0 grid-rows-subgrid gap-2 border border-line bg-paper p-3">
      <figcaption className="flex items-start justify-between gap-3 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">
        <span>Screen capture · {shot.caption}</span>
        {!failed && <span aria-hidden="true">↗</span>}
      </figcaption>
      {failed ? (
        <p className="text-sm text-muted">This screen capture could not be loaded.</p>
      ) : (
        <a href={`/captures/${shot.id}`} target="_blank" rel="noreferrer" className="block self-start border border-line bg-panel hover:border-ink">
          <img ref={failedBeforeHydration} src={`/api/artifacts/${shot.id}`} alt={shot.alt} width={1280} height={720} loading="lazy" onError={onFailed} className="block h-auto w-full" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </figure>
  );
}

function Capture({ shot }: { shot: Shot }) {
  const [failed, setFailed] = useState(false);
  return <CaptureFrame shot={shot} failed={failed} onFailed={() => setFailed(true)} />;
}

export function FindingScreenshots({ title, screenshots }: { title: string; screenshots: { reported: string | null; replayed: string | null } }) {
  const shots: Shot[] = [
    ...(screenshots.reported ? [{ id: screenshots.reported, caption: "when reported", alt: `The page when “${title}” was reported` }] : []),
    ...(screenshots.replayed ? [{ id: screenshots.replayed, caption: "where the replay ended", alt: `The page where the replay of “${title}” ended` }] : []),
  ];
  if (shots.length === 0) return null;
  return (
    <div className="@container flex flex-col gap-2">
      <div className={`grid gap-3 ${shots.length > 1 ? "@xl:grid-cols-2" : ""}`}>
        {shots.map((shot) => <Capture key={shot.id} shot={shot} />)}
      </div>
      <p className="text-xs text-muted">Passwords and other secrets are blacked out in screen captures.</p>
    </div>
  );
}
