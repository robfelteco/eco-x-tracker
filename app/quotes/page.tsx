import { getQueue, queueCounts, latestRun, getRosterSuggestions } from "@/lib/quoteDiscovery";
import { rosterCounts } from "@/lib/quoteRoster";
import { getReviewCount } from "@/lib/queries";
import { Sidebar } from "@/app/components/Sidebar";
import { Eyebrow, Panel } from "@/app/components/ui";
import { CollapsibleSection } from "@/app/components/Collapse";
import { QuoteQueue } from "@/app/components/QuoteQueue";
import { RosterTray } from "@/app/components/RosterTray";

export const dynamic = "force-dynamic";

// The full quote review queue. The Prioritize card carries a short version of
// this; here you get the whole queue, the approved shelf, and the roster tray.
export default async function QuotesPage() {
  const [queue, approved, counts, run, suggestions, roster, reviewCount] = await Promise.all([
    getQueue(200, "candidate"),
    getQueue(50, "approved"),
    queueCounts(),
    latestRun(),
    getRosterSuggestions(50),
    rosterCounts(),
    getReviewCount(),
  ]);

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Quote discovery</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">Quotes worth a card</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">
          Verbatim, attributable stablecoin quotes from credible people at credible organizations. Every candidate has
          been matched back against its source before it got here — if you have to go verify one by hand, that&apos;s a
          bug, not a judgement call.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="In queue" value={String(counts.candidate)} />
          <Stat label="Approved" value={String(counts.approved)} />
          <Stat label="Rejected" value={String(counts.rejected)} />
          <Stat label="Roster" value={`${roster.people} people`} />
          <Stat
            label="Last run"
            value={run ? `${run.status}${run.spendCents ? ` · $${(run.spendCents / 100).toFixed(2)}` : ""}` : "never"}
          />
        </div>

        <div className="mt-6">
          <Eyebrow>Review queue</Eyebrow>
          <div className="mt-3">
            <QuoteQueue initial={queue} />
          </div>
        </div>

        <CollapsibleSection
          title="Add to roster?"
          count={suggestions.length}
          hint="names the keyword sweep surfaced — not quote candidates"
        >
          <RosterTray initial={suggestions} />
        </CollapsibleSection>

        <CollapsibleSection title="Approved — ready to card" count={approved.length}>
          <div className="space-y-2">
            {approved.length === 0 ? (
              <p className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-4 text-center text-xs text-white/35">
                Nothing approved yet.
              </p>
            ) : (
              approved.map((q) => (
                <div key={q.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                  <p className="text-sm leading-snug text-white/90">&ldquo;{q.quoteText}&rdquo;</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-white/45">
                    <span className="font-medium text-white/75">{q.speakerName}</span>
                    {q.speakerTitle && <span>{q.speakerTitle}</span>}
                    {q.orgName && <span>· {q.orgName}</span>}
                    <a href={q.deepLink} target="_blank" rel="noreferrer" className="font-mono text-[10px] text-eco-lightblue/80 hover:text-eco-lightblue">
                      source ↗
                    </a>
                  </div>
                </div>
              ))
            )}
          </div>
        </CollapsibleSection>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Panel className="p-3">
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1 text-lg font-medium tracking-[-0.01em] text-white/90">{value}</div>
    </Panel>
  );
}
