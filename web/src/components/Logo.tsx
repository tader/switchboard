export function Logo({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-indigo-600" />
      <circle cx="16" cy="16" r="4" fill="#fff" />
      <g stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M16 6v4M16 22v4M6 16h4M22 16h4" />
      </g>
    </svg>
  );
}
