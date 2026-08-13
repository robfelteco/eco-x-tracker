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
  if (!src) return <div className={box} style={dim} aria-hidden />;
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
