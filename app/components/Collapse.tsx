"use client";

import { useCallback, useState, type ReactNode } from "react";

// One disclosure primitive, three depths.
//
// The problem this fixes: pillar cards (depth 1), the lane/product rows inside
// RecActions (depth 2) and post copy in tables (depth 3) used to be three
// unrelated widgets with three different — and mostly invisible — affordances.
// Depth 2 had no hover style at all. Learning one taught you nothing about the
// others, so the nesting was undiscoverable on a first visit. They are now
// visibly the same control at three sizes.
//
// Four signals, scaled by depth:
//   · accent rail — a left-edge bar that wipes in on hover
//   · chevron     — brighter at rest than it was, nudges right on hover,
//                   rotates on open
//   · cue line    — wakes to eco-lightblue on hover; says what a click does
//   · count pill  — how much is inside, readable WITHOUT hovering
//
// Plus a "2 levels" marker on anything that nests, so a first-time reader can
// see there is another layer inside before committing to a click.

const RAIL =
  "before:pointer-events-none before:absolute before:left-0 before:top-[14%] before:h-[72%] " +
  "before:w-[2px] before:origin-center before:scale-y-0 before:rounded-full before:bg-eco-lightblue " +
  "before:opacity-0 before:transition before:duration-200 hover:before:scale-y-100 hover:before:opacity-100 " +
  "motion-reduce:before:transition-none";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      className={`h-3 w-3 flex-none transition duration-200 motion-reduce:transition-none ${
        open ? "rotate-90 text-eco-lightblue" : "text-white/45"
      } group-hover/disc:translate-x-[3px] group-hover/disc:text-eco-lightblue`}
    >
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// How much is behind the click. The single most useful thing a first-time
// reader can know without hovering anything.
function CountPill({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex flex-none items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] leading-none transition duration-200 motion-reduce:transition-none ${
        open ? "border-eco-lightblue/30 text-eco-lightblue" : "border-white/10 text-white/40"
      }`}
    >
      {children}
    </span>
  );
}

// Marks a card that has its own accordions inside it — the "you can't tell
// there are sub-sections" complaint, answered before the click rather than
// after it.
function DepthMark({ open }: { open: boolean }) {
  return (
    <span
      title="This pillar has its own sections inside — open it, then open one of those."
      className={`inline-flex flex-none items-center rounded-md border border-dashed border-white/15 px-1.5 py-0.5 font-mono text-[9px] uppercase leading-none tracking-wider text-white/30 transition duration-200 motion-reduce:transition-none ${
        open ? "opacity-40" : ""
      }`}
    >
      2 levels
    </span>
  );
}

// Animated height. `grid-template-rows: 0fr → 1fr` transitions without having
// to measure anything in JS.
function Panel({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      }`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

// Panels stay unmounted until first opened — the shelves render thumbnails, and
// mounting every pillar's shelf on page load would fire that many image
// requests for content nobody has asked to see. Mounting at 0fr and flipping to
// 1fr on the next frame keeps the first open animated rather than popping.
function useDisclosure(defaultOpen: boolean) {
  const [open, setOpen] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    if (mounted) {
      setOpen(true);
      return;
    }
    setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
  }, [open, mounted]);

  return { open, mounted, toggle };
}

// ---------------------------------------------------------------------------
// Depth 1 — a pillar card. `header` is always visible and is the click target.
//
// The header holds an <h3> and a <ul>, which a <button> may not contain, so
// this stays a div with role="button" and its own key handling.
export function ExpandableCard({
  header,
  children,
  highlight = false,
  actionLabel = "Draft / act on this",
  count,
  nested = false,
  defaultOpen = false,
}: {
  header: ReactNode;
  children: ReactNode;
  highlight?: boolean;
  actionLabel?: string;
  count?: ReactNode;
  nested?: boolean;
  defaultOpen?: boolean;
}) {
  const { open, mounted, toggle } = useDisclosure(defaultOpen);
  return (
    <div
      className={`rounded-2xl border transition duration-200 motion-reduce:transition-none ${
        highlight
          ? "border-eco-lightblue/40 bg-eco-lightblue/[0.04] hover:border-eco-lightblue/60"
          : "border-white/10 bg-white/[0.03] hover:border-white/25"
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className={`group/disc relative cursor-pointer rounded-2xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-eco-lightblue/60 ${RAIL}`}
      >
        {header}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-white/40 transition-colors duration-200 group-hover/disc:text-eco-lightblue motion-reduce:transition-none">
          <Chevron open={open} />
          <span>{open ? "Collapse" : actionLabel}</span>
          {count != null && <CountPill open={open}>{count}</CountPill>}
          {nested && <DepthMark open={open} />}
        </div>
      </div>
      <Panel open={open}>{mounted && <div className="px-4 pb-4">{children}</div>}</Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Depth 2 — a row inside an expanded pillar (an audience lane, a product).
// Same four signals as depth 1, smaller. This is the one that previously had
// no hover state whatsoever.
export function NestedDisclosure({
  label,
  sublabel,
  count,
  open,
  onToggle,
  children,
}: {
  label: ReactNode;
  sublabel?: ReactNode;
  count?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] transition duration-200 hover:border-white/25 motion-reduce:transition-none">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`group/disc relative flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-eco-lightblue/60 ${RAIL}`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 flex-none rounded-full transition duration-200 motion-reduce:transition-none ${
            open ? "bg-eco-lightblue" : "bg-white/25"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-white/85 transition-colors duration-200 group-hover/disc:text-white motion-reduce:transition-none">
            {label}
          </span>
          {sublabel && <span className="mt-0.5 block truncate font-mono text-[10px] text-white/35">{sublabel}</span>}
        </span>
        {count != null && <CountPill open={open}>{count}</CountPill>}
        <Chevron open={open} />
      </button>
      <Panel open={open}>
        <div className="space-y-1.5 border-t border-white/[0.06] px-3 pb-3 pt-2">{children}</div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
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
  const { open, mounted, toggle } = useDisclosure(defaultOpen);
  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`group/disc relative flex w-full cursor-pointer items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left outline-none transition duration-200 hover:border-white/25 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-eco-lightblue/60 motion-reduce:transition-none ${RAIL}`}
      >
        <Chevron open={open} />
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-white/45 transition-colors duration-200 group-hover/disc:text-eco-lightblue motion-reduce:transition-none">
          {title}
        </span>
        {count != null && <CountPill open={open}>{count}</CountPill>}
        {hint && <span className="ml-auto text-[11px] text-white/25">{hint}</span>}
      </button>
      <Panel open={open}>{mounted && <div className="mt-3">{children}</div>}</Panel>
    </div>
  );
}
