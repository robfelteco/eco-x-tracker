"use client";

import { useState } from "react";

// The "Add to roster?" tray (spec §5.5).
//
// The 7-day keyword sweep is roster DISCOVERY, not a quote source — its results
// never become candidates. This is how the roster grows without hand-curating
// it, while the expensive per-post read budget stays pointed at people already
// vetted.

export interface Suggestion {
  id: number;
  xHandle: string;
  displayName: string | null;
  bio: string | null;
  followers: number | null;
  seenCount: number;
  sampleUrl: string | null;
}

export function RosterTray({ initial }: { initial: Suggestion[] }) {
  const [items, setItems] = useState(initial);
  const [editing, setEditing] = useState<number | null>(null);

  async function act(id: number, body: Record<string, unknown>) {
    const res = await fetch("/api/quotes/roster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    const data = await res.json();
    if (data.ok) setItems((cur) => cur.filter((s) => s.id !== id));
  }

  if (!items.length) {
    return (
      <p className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-4 text-center text-xs text-white/35">
        No new names. The keyword sweep adds them as it runs.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((s) => (
        <div key={s.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-white/85">{s.displayName ?? s.xHandle}</span>
            <a
              href={`https://x.com/${s.xHandle}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-eco-lightblue/80 hover:text-eco-lightblue"
            >
              @{s.xHandle}
            </a>
            {s.followers != null && (
              <span className="font-mono text-[10px] text-white/30">
                {Intl.NumberFormat("en-US", { notation: "compact" }).format(s.followers)} followers
              </span>
            )}
            <span className="font-mono text-[10px] text-white/30">seen {s.seenCount}×</span>
            {s.sampleUrl && (
              <a href={s.sampleUrl} target="_blank" rel="noreferrer" className="font-mono text-[10px] text-white/35 hover:text-white/60">
                sample ↗
              </a>
            )}
          </div>
          {s.bio && <p className="mt-1 line-clamp-2 text-xs text-white/45">{s.bio}</p>}

          {editing === s.id ? (
            <AddForm
              defaultName={s.displayName ?? ""}
              onCancel={() => setEditing(null)}
              onSubmit={(v) => act(s.id, { action: "add", ...v })}
            />
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => setEditing(s.id)}
                className="rounded-full bg-eco-blue px-3 py-1 text-xs font-medium text-white transition hover:brightness-110"
              >
                Add to roster
              </button>
              <button
                onClick={() => act(s.id, { action: "ignore" })}
                className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/55 transition hover:border-white/30 hover:text-white/85"
              >
                Ignore
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AddForm({
  defaultName,
  onCancel,
  onSubmit,
}: {
  defaultName: string;
  onCancel: () => void;
  onSubmit: (v: { fullName: string; title: string; orgName: string; seniority: number }) => void;
}) {
  const [fullName, setFullName] = useState(defaultName);
  const [title, setTitle] = useState("");
  const [orgName, setOrgName] = useState("");
  const [seniority, setSeniority] = useState(2);
  const input = "rounded-md border border-white/12 bg-transparent px-2 py-1 text-xs text-white/80 placeholder:text-white/25";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <input className={input} placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
      <input className={input} placeholder="Title (as stated)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className={input} placeholder="Org" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
      <select
        value={seniority}
        onChange={(e) => setSeniority(Number(e.target.value))}
        className="rounded-md border border-white/12 bg-transparent px-1.5 py-1 text-xs text-white/70"
      >
        <option className="bg-[#0a0a0a]" value={1}>C-suite / founder</option>
        <option className="bg-[#0a0a0a]" value={2}>SVP / MD / Head of</option>
        <option className="bg-[#0a0a0a]" value={3}>Director / PM</option>
      </select>
      <button
        onClick={() => fullName && title && onSubmit({ fullName, title, orgName, seniority })}
        disabled={!fullName || !title}
        className="rounded-full bg-eco-blue px-3 py-1 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-40"
      >
        Save
      </button>
      <button onClick={onCancel} className="px-1 text-[11px] text-white/30 hover:text-white/60">cancel</button>
    </div>
  );
}
