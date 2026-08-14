import { notFound } from "next/navigation";
import { getTemplateDetail } from "@/lib/stats";
import { getReviewCount } from "@/lib/queries";
import { isTemplate, TEMPLATE_BY_ID } from "@/lib/taxonomy";
import { Sidebar } from "@/app/components/Sidebar";
import { FilterBar } from "@/app/components/FilterBar";
import { parseFilter } from "@/lib/filter";
import { Panel, Eyebrow } from "@/app/components/ui";
import { Bars } from "@/app/components/Bars";
import { TemplatePostsTable } from "@/app/components/TemplatePostsTable";

export const dynamic = "force-dynamic";

function fmt(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

export default async function TemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ template: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { template } = await params;
  if (!isTemplate(template)) notFound();
  const filter = parseFilter(await searchParams);
  const [{ stat, posts, weekly }, reviewCount] = await Promise.all([
    getTemplateDetail(template, filter),
    getReviewCount(),
  ]);
  const def = TEMPLATE_BY_ID[template];

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      <Sidebar reviewCount={reviewCount} />
      <main className="min-w-0 flex-1">
        <Eyebrow>Template</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-medium tracking-[-0.02em]">{def.label}</h1>
        <p className="mt-1 max-w-2xl text-sm text-white/45">{def.description}</p>

        <div className="mt-4">
          <FilterBar />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Last posted" value={stat.lastPosted ? new Date(stat.lastPosted).toISOString().slice(0, 10) : "never"} />
          <Stat label="Days since" value={stat.daysSince != null ? String(stat.daysSince) : "—"} />
          <Stat label="Posts 30d" value={String(stat.count30)} />
          <Stat label="Posts 90d" value={String(stat.count90)} />
          <Stat label="Median impr" value={fmt(stat.medianImpr)} />
          <Stat label="Avg eng" value={stat.avgEngRate == null ? "—" : `${(stat.avgEngRate * 100).toFixed(1)}%`} />
        </div>

        <div className="mt-6">
          <Eyebrow>Posts per week</Eyebrow>
          <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <Bars data={weekly} />
          </div>
        </div>

        <div className="mt-6">
          <TemplatePostsTable posts={posts} />
        </div>
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
