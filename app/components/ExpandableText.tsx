"use client";

import { useState } from "react";

// Click-to-expand post copy. Collapsed, it line-clamps to `lines` so rows stay
// scannable; clicking anywhere on the text toggles the full copy open (and back)
// right inside the table — no need to open the post on X just to read it.
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
      className="block w-full cursor-pointer text-left text-white/80 transition hover:text-white"
    >
      <span className={open ? "whitespace-pre-wrap" : clamp}>{value}</span>
    </button>
  );
}
