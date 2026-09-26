type Shot = { id: string; caption: string; alt: string };

export function FindingScreenshots({ title, screenshots }: { title: string; screenshots: { reported: string | null; replayed: string | null } }) {
  const shots: Shot[] = [
    ...(screenshots.reported ? [{ id: screenshots.reported, caption: "when reported", alt: `The page when “${title}” was reported` }] : []),
    ...(screenshots.replayed ? [{ id: screenshots.replayed, caption: "in the replay", alt: `The page where the replay of “${title}” ended` }] : []),
  ];
  if (shots.length === 0) return null;
  return (
    <div className={`grid gap-3 ${shots.length > 1 ? "sm:grid-cols-2" : ""}`}>
      {shots.map((shot) => (
        <figure key={shot.id} className="flex min-w-0 flex-col gap-2 border border-line bg-soft p-3">
          <figcaption className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Screen capture · {shot.caption}</figcaption>
          <a href={`/api/artifacts/${shot.id}`} target="_blank" rel="noreferrer" className="block border border-line bg-paper hover:border-ink">
            <img src={`/api/artifacts/${shot.id}`} alt={shot.alt} loading="lazy" className="block h-auto w-full" />
            <span className="sr-only"> (opens full size in a new tab)</span>
          </a>
        </figure>
      ))}
    </div>
  );
}
