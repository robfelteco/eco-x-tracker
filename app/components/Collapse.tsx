"use client";

import { useState, type ReactNode } from "react";

// Two disclosure primitives for the Prioritize page.
//
// Robert's ask: stop scrolling. The page should read as a ranked list you can
// scan at a glance, with the actionable machinery (draft copy, discover, mark
// as used) tucked one click away inside each pillar.

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      className={`h-3 w-3 flex-none text-white/35 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    >
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A pillar card: `header` is always visible and is the click target; `children`
// (everything below the break line) only mounts once expanded.
export function ExpandableCard({
  header,
  children,
  highlight = false,
  actionLabel = "Draft / act on this",
}: {
  header: ReactNode;
  children: ReactNode;
  highlight?: boolean;
  actionLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rounded-2xl border transition ${
        highlight ? "border-eco-lightblue/40 bg-eco-lightblue/[0.04]" : "border-white/10 bg-white/[0.03]"
      } ${open ? "" : "hover:border-white/20"}`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="cursor-pointer p-4"
      >
        {header}
        <div className="mt-2.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-white/30">
          <Chevron open={open} />
          {open ? "Collapse" : actionLabel}
        </div>
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

// A page section that collapses behind its own eyebrow header.
export function CollapsibleSection({
  title,
  count,
  hint,
  children,
  defaultOpen = false,
}: {
  title: string;
  count?: number;
  hint?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left transition hover:border-white/15 hover:bg-white/[0.04]"
      >
        <Chevron open={open} />
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-white/40">{title}</span>
        {count != null && <span className="font-mono text-[10px] text-white/25">{count}</span>}
        {hint && <span className="ml-auto text-[11px] text-white/25">{hint}</span>}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}
