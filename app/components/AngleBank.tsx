"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AngleBank as Bank, EducationAngle } from "@/lib/angleBank";

// Broad Educational's angle bank.
//
// This is what replaced the pillar's drafter. The drafter was not broken so much
// as pointed at the wrong step: it could turn a source into a post, and the
// thing that was missing was the FRAME — what is this teaching, and how does it
// get to what Eco does. Jay's call was to stop automating this one and work the
// angles by hand first, using the tracker to keep score of what has been worked
// out and what has been used.
//
// So the form asks for the four things a usable angle needs, and the bridge
// field is the one that is allowed to be empty and then counted: "3 banked, 2
// still missing the Eco bridge" is a truer picture of the pillar than any
// generated draft was.

const ICPS = [
  { id: "", label: "No ICP yet" },
  { id: "institutional", label: "Institutional (finance, payments, treasury)" },
  { id: "developer", label: "Developer (stablecoin infra builders)" },
];

export function AngleBank({ bank, analogs }: { bank: Bank; analogs: { id: string; label: string }[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showUsed, setShowUsed] = useState(false);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/angles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Save failed");
      setAdding(false);
      setEditing(null);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      await fetch(`/api/angles?id=${id}`, { method: "DELETE" });
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const banked = bank.angles.filter((a) => a.status === "banked");
  const parked = bank.angles.filter((a) => a.status === "parked");
  const used = bank.angles.filter((a) => a.status === "used");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-white/45">
          {bank.banked} banked
          {bank.missingBridge > 0 && (
            <span className="text-amber-300/70"> · {bank.missingBridge} still missing the Eco bridge</span>
          )}
          {bank.used > 0 && <span className="text-white/30"> · {bank.used} used</span>}
        </div>
        <button
          onClick={() => {
            setAdding((v) => !v);
            setEditing(null);
          }}
          className="rounded-full bg-eco-blue px-3 py-1 text-xs font-medium text-white transition hover:brightness-110"
        >
          {adding ? "Cancel" : "Bank an angle"}
        </button>
      </div>

      {err && <p className="rounded-lg border border-red-400/25 bg-red-400/[0.07] px-3 py-2 text-xs text-red-300">{err}</p>}

      {adding && <AngleForm analogs={analogs} busy={busy} onSave={post} onCancel={() => setAdding(false)} />}

      {bank.angles.length === 0 && !adding && (
        <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 text-xs text-white/40">
          Nothing banked yet. The curriculum shelf below is the raw material — read a source, work out what it
          actually teaches an ICP, and bank the frame here. The drafting comes later, by hand, once a few of these
          have been posted and you know which frames land.
        </p>
      )}

      {[...banked, ...parked].map((a) =>
        editing === a.id ? (
          <AngleForm
            key={a.id}
            analogs={analogs}
            busy={busy}
            initial={a}
            onSave={post}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <AngleRow
            key={a.id}
            a={a}
            busy={busy}
            onEdit={() => {
              setEditing(a.id);
              setAdding(false);
            }}
            onStatus={(status) => post({ id: a.id, status })}
            onDelete={() => remove(a.id)}
          />
        ),
      )}

      {used.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => setShowUsed((v) => !v)}
            className="font-mono text-[10px] uppercase tracking-wider text-white/30 hover:text-white/50"
          >
            {showUsed ? "Hide" : "Show"} {used.length} used
          </button>
          {showUsed && (
            <div className="mt-1.5 space-y-1.5">
              {used.map((a) => (
                <AngleRow
                  key={a.id}
                  a={a}
                  busy={busy}
                  onEdit={() => setEditing(a.id)}
                  onStatus={(status) => post({ id: a.id, status })}
                  onDelete={() => remove(a.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AngleRow({
  a,
  busy,
  onEdit,
  onStatus,
  onDelete,
}: {
  a: EducationAngle;
  busy: boolean;
  onEdit: () => void;
  onStatus: (s: "banked" | "used" | "parked") => void;
  onDelete: () => void;
}) {
  const noBridge = !a.ecoBridge?.trim();
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        a.status === "used" ? "border-white/[0.07] bg-white/[0.015]" : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${a.status === "used" ? "text-white/45" : "text-white/85"}`}>{a.frame}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {a.analogLabel && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-white/50">
                {a.analogLabel}
              </span>
            )}
            {a.icp && (
              <span className="rounded bg-eco-blue/15 px-1.5 py-0.5 font-mono text-[9px] text-eco-lightblue">
                {a.icp}
              </span>
            )}
            {a.status === "parked" && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-white/40">parked</span>
            )}
            {noBridge && a.status === "banked" && (
              <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[9px] text-amber-300">
                no Eco bridge
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-none items-center gap-1.5 text-[11px]">
          {a.status !== "used" && (
            <button
              onClick={() => onStatus("used")}
              disabled={busy}
              className="rounded-full border border-white/15 px-2 py-0.5 text-white/60 transition hover:border-white/30 hover:text-white/90 disabled:opacity-40"
            >
              Mark posted
            </button>
          )}
          {a.status === "banked" && (
            <button
              onClick={() => onStatus("parked")}
              disabled={busy}
              className="rounded-full border border-white/10 px-2 py-0.5 text-white/40 transition hover:text-white/70 disabled:opacity-40"
            >
              Park
            </button>
          )}
          {a.status !== "banked" && (
            <button
              onClick={() => onStatus("banked")}
              disabled={busy}
              className="rounded-full border border-white/10 px-2 py-0.5 text-white/40 transition hover:text-white/70 disabled:opacity-40"
            >
              Re-bank
            </button>
          )}
          <button
            onClick={onEdit}
            className="rounded-full border border-white/10 px-2 py-0.5 text-white/40 transition hover:text-white/70"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="px-1 text-white/25 transition hover:text-red-300 disabled:opacity-40"
            title="Delete"
          >
            ×
          </button>
        </div>
      </div>

      {(a.mechanism || a.ecoBridge || a.sourceNote) && (
        <dl className="mt-2 space-y-1 border-t border-white/[0.06] pt-2 text-[11px]">
          {a.mechanism && <Field label="Mechanism" value={a.mechanism} />}
          {a.ecoBridge && <Field label="Eco bridge" value={a.ecoBridge} />}
          {a.sourceNote && <Field label="Evidence" value={a.sourceNote} />}
        </dl>
      )}
      {a.sourceUrl && (
        <a
          href={a.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block max-w-full truncate text-[11px] text-eco-lightblue hover:underline"
        >
          {a.sourceUrl}
        </a>
      )}
      {a.usedPostUrl && (
        <a
          href={a.usedPostUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 ml-2 inline-block text-[11px] text-white/40 hover:text-eco-lightblue"
        >
          the post →
        </a>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 flex-none font-mono text-[9px] uppercase tracking-wider text-white/30">{label}</dt>
      <dd className="min-w-0 flex-1 text-white/60">{value}</dd>
    </div>
  );
}

function AngleForm({
  analogs,
  busy,
  initial,
  onSave,
  onCancel,
}: {
  analogs: { id: string; label: string }[];
  busy: boolean;
  initial?: EducationAngle;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [frame, setFrame] = useState(initial?.frame ?? "");
  const [mechanism, setMechanism] = useState(initial?.mechanism ?? "");
  const [ecoBridge, setEcoBridge] = useState(initial?.ecoBridge ?? "");
  const [icp, setIcp] = useState(initial?.icp ?? "");
  const [analogId, setAnalogId] = useState(initial?.analogId ?? "");
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? "");
  const [sourceNote, setSourceNote] = useState(initial?.sourceNote ?? "");

  return (
    <div className="space-y-2 rounded-xl border border-eco-blue/25 bg-eco-blue/[0.04] px-3 py-3">
      <Input
        label="Frame"
        hint="The angle in one line, as you'd pitch it out loud."
        value={frame}
        onChange={setFrame}
        placeholder="Swift moves $X a day at Y cost — stablecoins settle the same value for Z. First inning."
        rows={2}
      />
      <Input
        label="Mechanism"
        hint="The TradFi thing this explains."
        value={mechanism}
        onChange={setMechanism}
        placeholder="Correspondent banking: nostro/vostro prefunding, and why it costs what it costs."
      />
      <Input
        label="Eco bridge"
        hint="How it gets to what Eco does. The hard half — leave it blank and it'll be flagged rather than forgotten."
        value={ecoBridge}
        onChange={setEcoBridge}
        placeholder="Prefunding is the cost. Routing across chains without prefunding each one is the product."
      />
      <div className="flex flex-wrap gap-2">
        <label className="flex-1 min-w-[10rem]">
          <span className="font-mono text-[9px] uppercase tracking-wider text-white/35">ICP</span>
          <select
            value={icp}
            onChange={(e) => setIcp(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white/80"
          >
            {ICPS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 min-w-[10rem]">
          <span className="font-mono text-[9px] uppercase tracking-wider text-white/35">Curriculum concept</span>
          <select
            value={analogId}
            onChange={(e) => setAnalogId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white/80"
          >
            <option value="">Not on the shelf</option>
            {analogs.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Input label="Source URL" value={sourceUrl} onChange={setSourceUrl} placeholder="https://…" />
      <Input
        label="Evidence"
        hint="The number or quote worth arguing from."
        value={sourceNote}
        onChange={setSourceNote}
        placeholder="$150T/yr in cross-border B2B; 2-5 day settlement (McKinsey, 2025)"
      />

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() =>
            onSave({
              id: initial?.id ?? null,
              frame,
              mechanism,
              ecoBridge,
              icp: icp || null,
              analogId: analogId || null,
              sourceUrl,
              sourceNote,
            })
          }
          disabled={busy || !frame.trim()}
          className="rounded-full bg-eco-blue px-3.5 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Bank it"}
        </button>
        <button onClick={onCancel} className="text-xs text-white/40 transition hover:text-white/70">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Input({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows = 1,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[9px] uppercase tracking-wider text-white/35">{label}</span>
      {hint && <span className="ml-1.5 text-[10px] text-white/25">{hint}</span>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white/85 placeholder:text-white/20 focus:border-eco-blue/50 focus:outline-none"
      />
    </label>
  );
}
