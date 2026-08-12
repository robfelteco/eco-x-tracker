import { getReviewQueue, getReviewCount } from "@/lib/queries";
import { Eyebrow } from "@/app/components/ui";
import { ReviewCard } from "@/app/components/ReviewCard";
import { Sidebar } from "@/app/components/Sidebar";

export const dynamic = "force-dynamic";

// Review queue — posts with confidence < 0.8, template = 'other', or unclassified.
// One-click confirm/correct; corrections become human-verified ground truth and
// join the few-shot pool for future Claude calls.
export default async function ReviewPage() {
  const [queue, reviewCount] = await Promise.all([getReviewQueue(100), getReviewCount()]);

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Review queue</Eyebrow>
        <h1 className="mt-2 text-2xl font-medium tracking-[-0.02em]">Low-confidence calls</h1>
        <p className="mt-1 text-sm text-white/55">
          {queue.length === 0
            ? "Nothing to review — every post is either high-confidence or human-verified."
            : `${queue.length} post${queue.length === 1 ? "" : "s"} need a human call. Pick the right template; your choice becomes ground truth.`}
        </p>

        <div className="mt-6 space-y-3">
          {queue.map((p) => (
            <ReviewCard key={p.id} post={p} />
          ))}
        </div>
      </main>
    </div>
  );
}
