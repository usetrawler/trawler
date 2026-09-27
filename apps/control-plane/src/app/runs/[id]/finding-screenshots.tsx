"use client";
import { useState } from "react";

export type Shot = { id: string; caption: string; alt: string };

export function CaptureFrame({ shot, failed, onFailed, onOpen }: { shot: Shot; failed: boolean; onFailed: () => void; onOpen: () => void }) {
  const failedBeforeHydration = (img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth === 0) onFailed();
  };
  return (
    <figure className="relative row-span-2 grid min-w-0 grid-rows-subgrid gap-2 border border-line bg-paper p-3">
      <figcaption className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Screen capture · {shot.caption}</figcaption>
      {failed ? (
        <p className="text-sm text-muted">This screen capture could not be loaded.</p>
      ) : (
        <a href={`/captures/${shot.id}`} onClick={onOpen} className="block self-start border border-line bg-panel after:absolute after:inset-0 hover:border-ink">
          <img ref={failedBeforeHydration} src={`/api/artifacts/${shot.id}`} alt={shot.alt} width={1280} height={720} loading="lazy" onError={onFailed} className="relative z-[1] block h-auto w-full" />
        </a>
      )}
    </figure>
  );
}

function Capture(props: { shot: Shot; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return <CaptureFrame {...props} failed={failed} onFailed={() => setFailed(true)} />;
}

export function FindingScreenshots({ title, screenshots, onOpen }: { title: string; screenshots: { reported: string | null; replayed: string | null }; onOpen: () => void }) {
  const shots: Shot[] = [
    ...(screenshots.reported ? [{ id: screenshots.reported, caption: "when reported", alt: `The page when “${title}” was reported` }] : []),
    ...(screenshots.replayed ? [{ id: screenshots.replayed, caption: "where the replay ended", alt: `The page where the replay of “${title}” ended` }] : []),
  ];
  if (shots.length === 0) return null;
  return (
    <div className="@container flex flex-col gap-2">
      <div className={`grid gap-3 ${shots.length > 1 ? "@xl:grid-cols-2" : ""}`}>
        {shots.map((shot) => <Capture key={shot.id} shot={shot} onOpen={onOpen} />)}
      </div>
      <p className="text-xs text-muted">Passwords and other secrets are blacked out in screen captures.</p>
    </div>
  );
}
