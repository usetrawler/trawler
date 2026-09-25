export function BrandMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={`${className} text-action`} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M6 24h27v11H23v23L12 47V35H6Z" fill="currentColor" />
      <path d="M31 7a26 26 0 0 1 26 26H46a15 15 0 0 0-15-15Z" fill="currentColor" />
      <circle cx="33" cy="33" r="6" fill="currentColor" />
    </svg>
  );
}
