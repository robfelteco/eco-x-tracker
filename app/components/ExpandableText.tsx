"use client";

import { useState } from "react";

// Depth 3 of the disclosure system — click-to-expand post copy. Collapsed, it
// line-clamps to `lines` so rows stay scannable; clicking anywhere on the text
// toggles the full copy open (and back) right inside the table.
//
// It carries the same chevron as the pillar cards and lane rows, plus a "More"
// marker, because a bare line-clamp gives a first-time reader no reason to
// think the row is clickable at all.
export function ExpandableText({
  text,
  lines = 2,
}: {
  text: string | null | undefined;
  lines?: number;
}) {
  const [open, setOpen] = useState(false);
  const value = text?.trim();

  if (!value) return <span className="text-white/30">—</span>;

  const clamp =
    lines === 1 ? "line-clamp-1" : lines === 3 ? "line-clamp-3" : "line-clamp-2";

  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      title={open ? "Collapse" : "Expand full copy"}
      className="group/disc flex w-full cursor-pointer items-start gap-2 rounded-md text-left text-white/80 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-eco-lightblue/60 motion-reduce:transition-none"
    >
      <svg
        viewBox="0 0 12 12"
        aria-hidden
        className={`mt-1 h-3 w-3 flex-none transition duration-200 motion-reduce:transition-none ${
          open ? "rotate-90 text-eco-lightblue" : "text-white/45"
        } group-hover/disc:translate-x-[3px] group-hover/disc:text-eco-lightblue`}
      >
        <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={`min-w-0 flex-1 ${open ? "whitespace-pre-wrap" : clamp}`}>{value}</span>
      {!open && (
        <span className="mt-1 flex-none font-mono text-[9px] uppercase leading-none tracking-wider text-white/25 transition-colors duration-200 group-hover/disc:text-eco-lightblue motion-reduce:transition-none">
          More
        </span>
      )}
    </button>
  );
}
