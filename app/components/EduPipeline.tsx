"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useAction, ActionProgress } from "./useAction";
import { SITE_AUDIENCES, siteAudienceLabel } from "@/lib/icp";
import type { EduPipeline as Board, EduCandidate, CandidateStatus } from "@/lib/eduIntake";
import type { CopyOption } from "@/lib/generateCopy";

// Broad Educational as ONE pipeline: INBOX -> PICKED -> DRAFTED -> POSTED.
//
// This replaces three surfaces that did not feed each other (an angle bank
// nobody filled, a four-tier curriculum accordion, a Discover button whose
// results vanished on reload). See docs/BROAD-ED-REDESIGN.md §3-4. The rule
// the component is built around: nothing is re-entered. A candidate arrives
// framed; picking is a thirty-second read and an edit; drafting is one click
// against the text intake already scraped; marking posted (or the next sync)
// closes it. Skips are remembered server-side and never come back.
//
// Tabs rather than four side-by-side columns: the card lives in a ~900px
// pillar card, and a kanban at that width is four unreadable slivers.

type Tab = Exclude<CandidateStatus, "skipped">;
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "inbox", label: "Inbox", hint: "Stocked nightly, ranked by how directly the piece implies an Eco theme. Pick or skip; skips never return." },
  { id: "picked", label: "Picked", hint: "The week's educational queue. Fix the frame and the bridge, set the audience, then Draft." },
  { id: "drafted", label: "Drafted", hint: "Three bands, grounded in the scraped text. Copy one to the composer, then Mark posted." },
  { id: "posted", label: "Posted", hint: "Closed. The sync matches the @eco post by URL and attaches impressions." },
];

// Mirrors EDU_THEMES in lib/eduIntake.ts as a plain literal, same reason the
// other client components duplicate registries: that module imports the
// Anthropic SDK and the database, neither of which belongs in the browser.
const THEME_LABEL: Record<string, string> = {
  fragmentation: "Fragmentation",
  pre_funding: "Pre-funding",
  all_or_nothing: "All-or-nothing",
  programmable_rules: "Programmable rules",
  tokenized_assets: "Tokenized assets",
  at_par: "At-par conversion",
  agents: "Agents",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (h < 1) return "just now";
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function scoreTone(n: number): string {
  if (n >= 80) return "bg-emerald-400/15 text-emerald-300";
  if (n >= 50) return "bg-white/[0.06] text-white/60";
  return "bg-amber-400/12 text-amber-300/80";
}

export function EduPipeline({
  pipeline: initial,
  analogOptions,
}: {
  pipeline: Board;
  analogOptions: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [board, setBoard] = useState<Board>(initial);
  const [tab, setTab] = useState<Tab>(initial.inbox.length || !initial.picked.length ? "inbox" : "picked");
  const [untaughtOnly, setUntaughtOnly] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [errById, setErrById] = useState<Record<number, string>>({});
  const [intakeErr, setIntakeErr] = useState<string | null>(null);
  const [intakeNote, setIntakeNote] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const draftAct = useAction("generate");
  const intakeAct = useAction("edu-intake");

  async function refresh() {
    const res = await fetch("/api/edu-candidates", { cache: "no-store" });
    const data = await res.json();
    if (data.ok) setBoard(data.pipeline);
    // The collapsed-row count on the pillar card is server-rendered.
    startTransition(() => router.refresh());
  }

  async function act(id: number, body: Record<string, unknown>) {
    setBusyId(id);
    setErrById((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch("/api/edu-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Action failed");
      await refresh();
    } catch (e) {
      setErrById((err) => ({ ...err, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }

  const setStatus = (id: number, status: CandidateStatus) => act(id, { action: "status", status });

  // Draft: the existing /api/generate with the candidate id. The server loads
  // the scraped text as the pinned source and the operator's frame as the
  // steer; what comes back is persisted on the candidate so a reload keeps it.
  async function draft(c: EduCandidate) {
    setBusyId(c.id);
    setErrById((e) => ({ ...e, [c.id]: "" }));
    try {
      const data = await draftAct.run(async () => {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            template: "broad_educational",
            eduCandidateId: c.id,
            analogId: c.analogId,
            angle: [c.frame, c.ecoBridge ? `Bridge: ${c.ecoBridge}` : null].filter(Boolean).join(" ").slice(0, 500) || null,
          }),
        });
        return res.json();
      });
      if (!data.ok) throw new Error(data.error || "Draft failed");
      const options = (data.options ?? []) as CopyOption[];
      if (!options.length) throw new Error("The drafter returned nothing usable.");
      const save = await fetch("/api/edu-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id, action: "drafts", drafts: options }),
      });
      const saved = await save.json();
      if (!saved.ok) throw new Error(saved.error || "Could not save the drafts");
      await refresh();
      setTab("drafted");
    } catch (e) {
      setErrById((err) => ({ ...err, [c.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }

  async function runIntake() {
    setIntakeErr(null);
    setIntakeNote(null);
    try {
      const data = await intakeAct.run(async () => {
        const res = await fetch("/api/edu-intake", { method: "POST" });
        return res.json();
      });
      if (!data.ok) throw new Error(data.error || "Intake failed");
      setIntakeNote(
        `${data.added} new · ${data.deduped} already seen · ${data.scrapeFailed} unreadable` +
          (data.warnings?.length ? ` · ${data.warnings.length} warning${data.warnings.length === 1 ? "" : "s"}` : ""),
      );
      await refresh();
      setTab("inbox");
    } catch (e) {
      setIntakeErr(e instanceof Error ? e.message : String(e));
    }
  }

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  const untaught = new Set(board.untaughtAnalogIds);
  const inbox = untaughtOnly ? board.inbox.filter((c) => c.analogId && untaught.has(c.analogId)) : board.inbox;
  const untaughtCount = board.inbox.filter((c) => c.analogId && untaught.has(c.analogId)).length;
  const counts: Record<Tab, number> = {
    inbox: board.inbox.length,
    picked: board.picked.length,
    drafted: board.drafted.length,
    posted: board.posted.length,
  };
  const list: EduCandidate[] = tab === "inbox" ? inbox : board[tab];
  const current = TABS.find((t) => t.id === tab)!;
  const run = board.lastRun;

  return (
    <div className="space-y-3">
      {/* Status strip: is the cron alive, and the manual override. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px]">
        <div className="text-white/50">
          {run ? (
            <>
              Stocked <span className="text-white/75">{ago(run.finishedAt ?? run.startedAt)}</span>
              <span className="text-white/35">
                {" "}
                · {run.added} new · {run.deduped} already seen
                {run.scrapeFailed > 0 && ` · ${run.scrapeFailed} unreadable`}
                {run.error && <span className="text-red-400/80"> · failed: {run.error.slice(0, 80)}</span>}
                {!run.finishedAt && !run.error && " · still running"}
              </span>
            </>
          ) : (
            <>Never stocked. The nightly cron fills this; run it now to see the first inbox.</>
          )}
          {board.skipped > 0 && <span className="text-white/30"> · {board.skipped} skipped, remembered</span>}
        </div>
        <div className="flex items-center gap-2">
          {intakeNote && <span className="font-mono text-[10px] text-emerald-300/80">{intakeNote}</span>}
          {intakeErr && <span className="font-mono text-[10px] text-red-400">{intakeErr}</span>}
          <button
            onClick={runIntake}
            disabled={intakeAct.pending}
            title="Three Grok lenses plus the newest current-tier curriculum sources. Scrapes, dedupes, scores and pre-frames each one. Spends credits; runs ~2-4 minutes."
            className="rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/70 transition hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {intakeAct.pending ? "Stocking…" : "Run intake now"}
          </button>
        </div>
      </div>
      {intakeAct.pending && <ActionProgress state={intakeAct.state} className="max-w-md" />}

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.hint}
              className={`rounded-full px-3 py-1 text-xs transition ${
                on ? "bg-eco-blue text-white" : "border border-white/10 text-white/55 hover:border-white/30 hover:text-white/85"
              }`}
            >
              {t.label}
              <span className={`ml-1.5 font-mono text-[10px] tabular-nums ${on ? "text-white/70" : "text-white/35"}`}>{counts[t.id]}</span>
            </button>
          );
        })}
        {tab === "inbox" && (
          <button
            onClick={() => setUntaughtOnly((v) => !v)}
            title="Only candidates tagged with a curriculum concept no @eco post has taught yet. The concept's parallel and break ride into the drafter."
            className={`ml-auto rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
              untaughtOnly ? "bg-emerald-400/15 text-emerald-300" : "border border-white/10 text-white/40 hover:border-white/30 hover:text-white/70"
            }`}
          >
            mechanisms never taught · {untaughtCount}
          </button>
        )}
      </div>
      <p className="text-[11px] text-white/35">{current.hint}</p>

      {list.length === 0 && (
        <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/40">
          {tab === "inbox" && (untaughtOnly ? "Nothing in the inbox carries an untaught concept right now." : "Inbox is empty. Run intake, or wait for tonight's cron.")}
          {tab === "picked" && "Nothing picked. Open the inbox and choose what this week teaches."}
          {tab === "drafted" && "Nothing drafted. Pick a candidate, fix its frame, then Draft."}
          {tab === "posted" && "Nothing closed yet. Mark a drafted candidate posted, or let the sync match the post by URL."}
        </p>
      )}

      <div className="space-y-1.5">
        {list.map((c) => {
          const busy = busyId === c.id;
          const err = errById[c.id];
          return (
            <div key={c.id} className="rounded-xl border border-white/10 bg-white/[0.02]">
              {/* The one-line read, every state. */}
              <div className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <a
                      href={c.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 truncate text-sm font-medium text-white/85 hover:text-eco-lightblue"
                      title={c.sourceTitle ?? c.sourceUrl}
                    >
                      {c.headline}
                    </a>
                    {tab === "inbox" && (
                      <span
                        className={`flex-none rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${scoreTone(c.adjacencyScore)}`}
                        title={c.adjacencyReasons.length ? c.adjacencyReasons.join(" ") : "Adjacency to the eco.com themes, 0-100."}
                      >
                        {c.adjacencyScore}
                      </span>
                    )}
                    {!c.rawDocumentId && (
                      <span className="flex-none rounded-full bg-amber-400/12 px-1.5 py-0.5 font-mono text-[10px] text-amber-300/80" title="Intake could not scrape this page, so there is no text to ground a draft in. Draft is disabled.">
                        unreadable
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-[10px] text-white/35">
                    <span>{c.publisher ?? hostOf(c.sourceUrl)}</span>
                    {c.audience && <><span>·</span><span>{siteAudienceLabel(c.audience)}</span></>}
                    {c.theme && <><span>·</span><span>{THEME_LABEL[c.theme] ?? c.theme}</span></>}
                    {c.analogLabel && (
                      <>
                        <span>·</span>
                        <span className={untaught.has(c.analogId ?? "") ? "text-emerald-300/80" : ""} title={untaught.has(c.analogId ?? "") ? "Never taught" : "Already taught"}>
                          {c.analogLabel}
                        </span>
                      </>
                    )}
                    {c.keyStat && <><span>·</span><span className="text-white/50">{c.keyStat}</span></>}
                    <span>·</span>
                    <span>{c.origin.replace("grok:", "")}</span>
                  </div>
                  {tab === "inbox" && (
                    <p className="mt-1 text-[11.5px] leading-snug text-white/55">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-white/30">bridge </span>
                      {c.ecoBridge ?? <span className="italic text-white/35">none pre-filled</span>}
                    </p>
                  )}
                </div>

                {/* Actions per state. */}
                <div className="flex flex-none flex-wrap items-center justify-end gap-1.5">
                  {tab === "inbox" && (
                    <>
                      <button onClick={() => setStatus(c.id, "picked")} disabled={busy} className="rounded-full bg-eco-blue px-3 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:opacity-50">
                        Pick
                      </button>
                      <button onClick={() => setStatus(c.id, "skipped")} disabled={busy} title="Remembered. This URL never comes back." className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/50 transition hover:border-white/30 hover:text-white/80 disabled:opacity-50">
                        Skip
                      </button>
                    </>
                  )}
                  {tab === "picked" && (
                    <>
                      <button
                        onClick={() => draft(c)}
                        disabled={busy || !c.rawDocumentId}
                        title={c.rawDocumentId ? "Three bands from the scraped text, with the frame as the steer." : "No scraped text; the grounding gate blocks this."}
                        className="rounded-full bg-eco-blue px-3 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy && draftAct.pending ? "Drafting…" : "Draft"}
                      </button>
                      <button onClick={() => setStatus(c.id, "inbox")} disabled={busy} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/50 transition hover:border-white/30 hover:text-white/80 disabled:opacity-50">
                        Unpick
                      </button>
                      <button onClick={() => setStatus(c.id, "skipped")} disabled={busy} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/50 transition hover:border-white/30 hover:text-white/80 disabled:opacity-50">
                        Skip
                      </button>
                    </>
                  )}
                  {tab === "drafted" && (
                    <>
                      <button onClick={() => setStatus(c.id, "posted")} disabled={busy} title="Moves it to Posted now. The next sync attaches the @eco post by URL." className="rounded-full bg-eco-blue px-3 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:opacity-50">
                        Mark posted
                      </button>
                      <button onClick={() => draft(c)} disabled={busy} className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/50 transition hover:border-white/30 hover:text-white/80 disabled:opacity-50">
                        {busy && draftAct.pending ? "Drafting…" : "Redraft"}
                      </button>
                      <button onClick={() => setStatus(c.id, "picked")} disabled={busy} title="Back to Picked to change the frame." className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/50 transition hover:border-white/30 hover:text-white/80 disabled:opacity-50">
                        Reframe
                      </button>
                    </>
                  )}
                  {tab === "posted" && (
                    c.usedPostUrl ? (
                      <a href={c.usedPostUrl} target="_blank" rel="noreferrer" className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10px] text-white/60 hover:border-white/30 hover:text-white/90">
                        @eco post{c.usedPostImpressions != null ? ` · ${c.usedPostImpressions.toLocaleString()} impr` : ""}
                      </a>
                    ) : (
                      <span className="font-mono text-[10px] text-white/35" title="Marked posted here. The sync matches the @eco post by its resolved URL.">
                        awaiting sync match
                      </span>
                    )
                  )}
                </div>
              </div>

              {busy && draftAct.pending && <div className="px-3 pb-2"><ActionProgress state={draftAct.state} className="max-w-md" /></div>}
              {err && <p className="px-3 pb-2 font-mono text-[11px] text-red-400">{err}</p>}

              {/* Picked: the human step. Four editable fields plus audience and concept. */}
              {tab === "picked" && <FrameEditor c={c} analogOptions={analogOptions} onSave={(edit) => act(c.id, { action: "edit", ...edit })} />}

              {/* Drafted: the three bands. */}
              {tab === "drafted" && c.drafts && (
                <div className="space-y-2 border-t border-white/[0.06] px-3 pb-3 pt-2">
                  {c.frame && <p className="text-[11px] text-white/45"><span className="font-mono text-[10px] uppercase tracking-wider text-white/30">frame </span>{c.frame}</p>}
                  {c.drafts.map((o, i) => (
                    <DraftOption key={i} o={o} copied={copiedId === `${c.id}-${i}`} onCopy={() => copy(o.text, `${c.id}-${i}`)} />
                  ))}
                  <p className="text-[10px] text-white/30">Starting points — take them to 90/10 before posting.</p>
                </div>
              )}

              {/* Inbox: reasons and summary behind a disclosure, so the list stays one line each. */}
              {tab === "inbox" && (c.summary || c.adjacencyReasons.length > 0 || c.frame) && (
                <details className="border-t border-white/[0.06] px-3 py-1.5">
                  <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-white/30 hover:text-white/60">why · frame</summary>
                  <div className="space-y-1 pb-1.5 pt-1 text-[11.5px] leading-snug text-white/55">
                    {c.frame && <p><span className="text-white/35">frame: </span>{c.frame}</p>}
                    {c.mechanism && <p><span className="text-white/35">mechanism: </span>{c.mechanism}</p>}
                    {c.evidence && <p><span className="text-white/35">evidence: </span>{c.evidence}</p>}
                    {c.summary && <p className="text-white/45">{c.summary}</p>}
                    {c.adjacencyReasons.map((r, i) => (
                      <p key={i} className="text-white/45"><span className="mr-1 text-white/25">›</span>{r}</p>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The frame step, kept deliberately human. Each field saves on blur; the
// audience and concept save on change. No "Save" button, because the fields
// arrive filled and the common edit is one sentence in one field.
function FrameEditor({
  c,
  analogOptions,
  onSave,
}: {
  c: EduCandidate;
  analogOptions: { id: string; label: string }[];
  onSave: (edit: Record<string, string | null>) => void;
}) {
  const [frame, setFrame] = useState(c.frame ?? "");
  const [mechanism, setMechanism] = useState(c.mechanism ?? "");
  const [bridge, setBridge] = useState(c.ecoBridge ?? "");
  const [evidence, setEvidence] = useState(c.evidence ?? "");

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    key: string,
    hint: string,
    warnEmpty = false,
  ) => (
    <label className="block">
      <span className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-wider text-white/35">
        {label}
        {warnEmpty && !value.trim() && <span className="normal-case tracking-normal text-amber-300/70">the half that stalls drafting</span>}
      </span>
      <textarea
        value={value}
        onChange={(e) => set(e.target.value)}
        onBlur={() => {
          if ((value ?? "") !== ((c as unknown as Record<string, string | null>)[key] ?? "")) onSave({ [key]: value });
        }}
        rows={2}
        placeholder={hint}
        className="mt-0.5 w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/80 placeholder:text-white/25 focus:border-eco-lightblue/50 focus:outline-none"
      />
    </label>
  );

  return (
    <div className="grid gap-2 border-t border-white/[0.06] px-3 pb-3 pt-2 sm:grid-cols-2">
      {field("Frame", frame, setFrame, "frame", "The angle in one line, as you'd pitch it.")}
      {field("Mechanism", mechanism, setMechanism, "mechanism", "The TradFi or market mechanism being explained.")}
      {field("Eco bridge", bridge, setBridge, "ecoBridge", "What the reader should infer. Eco is never named.", true)}
      {field("Evidence", evidence, setEvidence, "evidence", "The number or quote the post rests on.")}
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">Audience</span>
        <select
          value={c.audience ?? ""}
          onChange={(e) => onSave({ audience: e.target.value || null })}
          className="mt-0.5 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/80 focus:border-eco-lightblue/50 focus:outline-none"
        >
          <option value="">No audience yet</option>
          {SITE_AUDIENCES.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">Curriculum concept</span>
        <select
          value={c.analogId ?? ""}
          onChange={(e) => onSave({ analogId: e.target.value || null })}
          className="mt-0.5 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/80 focus:border-eco-lightblue/50 focus:outline-none"
        >
          <option value="">News, no concept</option>
          {analogOptions.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

// One returned draft. The same read as RecActions' draft list: band and score
// pills, Copy, the text, the rationale, any surviving findings, the citation.
function DraftOption({ o, copied, onCopy }: { o: CopyOption; copied: boolean; onCopy: () => void }) {
  const band = o.text.length < 280 ? "tight" : o.text.length < 900 ? "mid" : "long";
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-eco-lightblue/80">
          <span className="truncate">{o.angle}</span>
          <span className="flex-none rounded-full bg-white/[0.06] px-1.5 py-0.5 tabular-nums text-white/45">{band} {o.text.length}</span>
          {o.score != null && (
            <span title={o.scoreNote ? `Weakest: ${o.scoreNote}` : undefined} className={`flex-none cursor-help rounded-full px-1.5 py-0.5 tabular-nums ${scoreTone(o.score)}`}>
              {o.score}
            </span>
          )}
        </span>
        <button onClick={onCopy} className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-white/60 transition hover:border-white/30 hover:text-white/90">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className="whitespace-pre-wrap text-sm text-white/85">{o.text}</p>
      {o.rationale && <p className="mt-1 text-[11px] italic text-white/40">{o.rationale}</p>}
      {!!o.slop?.length && (
        <div className="mt-2 space-y-1 border-t border-white/[0.06] pt-1.5">
          {o.slop.map((f, j) => (
            <div key={j} className="flex items-baseline gap-1.5 text-[10.5px] leading-snug">
              <span className={`flex-none rounded px-1 py-px font-mono text-[9px] uppercase tracking-wider ${f.severity === "hard" ? "bg-red-400/15 text-red-300" : "bg-amber-400/12 text-amber-300/80"}`}>{f.rule}</span>
              <span className="min-w-0 text-white/45"><span className="text-white/70">&ldquo;{f.match}&rdquo;</span> {f.fix}</span>
            </div>
          ))}
        </div>
      )}
      {o.sourceTitle && (
        <div className="mt-2 flex items-baseline gap-2 border-t border-white/[0.06] pt-1.5">
          <span className="flex-none font-mono text-[9.5px] uppercase tracking-wider text-white/30">Argued from</span>
          <span className="min-w-0 text-[11.5px] leading-snug text-white/60">
            {o.sourceUrl ? (
              <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-eco-lightblue">{o.sourceTitle}</a>
            ) : o.sourceTitle}
          </span>
        </div>
      )}
    </div>
  );
}
