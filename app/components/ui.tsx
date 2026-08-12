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
