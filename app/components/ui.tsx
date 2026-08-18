import type { ReactNode } from "react";

// Canonical Eco house-style primitives (from eco-design-kit DESIGN-SYSTEM.md),
// adapted to Tailwind v4. Import these instead of re-typing the class strings.

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.03] p-5 ${className}`}>{children}</div>
  );
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-white/40 ${className}`}>
      {children}
    </div>
  );
}

type BadgeTone = "success" | "warning" | "brand" | "neutral";
const BADGE_TONES: Record<BadgeTone, string> = {
  success: "bg-emerald-400/15 text-emerald-300",
  warning: "bg-amber-400/15 text-amber-300",
  brand: "bg-eco-lightblue/15 text-eco-lightblue",
  neutral: "bg-white/[0.06] text-white/60",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}>{children}</span>;
}

// Tiny mono tag chip (row-kind labels).
export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "amber" | "brand" }) {
  const cls =
    tone === "amber"
      ? "bg-amber-400/15 text-amber-300"
      : tone === "brand"
        ? "bg-eco-lightblue/15 text-eco-lightblue"
        : "bg-white/[0.06] text-white/45";
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wider ${cls}`}>{children}</span>
  );
}

// Post thumbnail. Shows the post's visual (native photo, video poster, or the
// resolved link/article card image) so it's recognizable without opening X.
// Falls back to an empty placeholder tile when a post has no image at all.
export function Thumb({
  src,
  href,
  size = 44,
}: {
  src: string | null;
  href?: string;
  size?: number;
}) {
  const dim = { width: size, height: size };
  const box =
    "flex-none overflow-hidden rounded-md border border-white/10 bg-white/[0.03]";
  // No image resolved for this post (pure-text post, dead/404 link, or an
  // X-article with no cover). Show a muted "no preview" glyph so the empty tile
  // reads as "couldn't pull an asset" rather than a loading/broken state — and
  // still link it to the post on X when we have the permalink.
  if (!src) {
    const glyph = Math.round(size * 0.44);
    const placeholder = (
      <div
        className={`${box} flex items-center justify-center text-white/20`}
        style={dim}
        title={href ? "No preview — open on X ↗" : "No preview available"}
      >
        {/* image-off icon */}
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 2l20 20" />
          <path d="M21 15.5V5a2 2 0 0 0-2-2H8.5" />
          <path d="M3.5 3.53A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 1.47-.53" />
          <path d="M21 15l-5-5" />
          <path d="M3 16l5-5 4 4" />
        </svg>
      </div>
    );
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title="No preview — open on X ↗"
        className="block transition hover:text-white/35 hover:opacity-90"
      >
        {placeholder}
      </a>
    ) : (
      placeholder
    );
  }
  const img = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      style={dim}
      className={`${box} object-cover transition hover:border-eco-lightblue/50`}
    />
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title="Open on X ↗">
      {img}
    </a>
  ) : (
    img
  );
}
