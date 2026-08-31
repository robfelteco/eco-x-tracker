"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, ActionProgress } from "./useAction";
import { TEMPLATE_DEFS, TEMPLATE_BY_ID, type Template } from "@/lib/taxonomy";
import type { ReviewRow } from "@/lib/queries";
import { Tag } from "@/app/components/ui";
import { pickThumb } from "@/lib/media";

// One review item: the post, its media, Claude's guess + reasoning, and a
// one-click button per template. Correcting marks it human-verified and adds it
// to the few-shot pool.
export function ReviewCard({ post }: { post: ReviewRow }) {
  const [saving, setSaving] = useState<Template | null>(null);
  const [done, setDone] = useState<Template | null>(null);
  const router = useRouter();
  const act = useAction("label");

  const img = pickThumb(post);
  const guess = post.template ? TEMPLATE_BY_ID[post.template]?.label ?? post.template : null;

  async function label(template: Template) {
    setSaving(template);
    try {
      const res = await act.run(async () =>
        fetch("/api/label", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId: post.id, template }),
        }),
      );
      if (res.ok) {
        setDone(template);
        setTimeout(() => router.refresh(), 400);
      }
    } finally {
      setSaving(null);
    }
  }

  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition ${done ? "opacity-40" : ""}`}
    >
      <div className="flex gap-4">
        {img && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt=""
            className="h-24 w-24 flex-none rounded-lg border border-white/10 object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 font-mono text-[10px] text-white/40">
            <span>{new Date(post.created_at).toISOString().slice(0, 10)}</span>
            <Tag>{post.media_type}</Tag>
            {post.class_source && <Tag>{post.class_source}</Tag>}
            <a href={post.url} target="_blank" rel="noreferrer" className="text-eco-lightblue hover:underline">
              open ↗
            </a>
          </div>
          <p className="line-clamp-3 text-sm text-white/80">
            {post.text?.trim() || <span className="text-white/30">(no tweet text — see linked article below)</span>}
          </p>
          {(post.link_title || post.link_description) && (
            <div className="mt-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5">
              <div className="font-mono text-[9px] uppercase tracking-wider text-white/30">linked article</div>
              {post.link_title && <p className="mt-0.5 text-xs font-medium text-white/75">{post.link_title}</p>}
              {post.link_description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-white/45">{post.link_description}</p>
              )}
            </div>
          )}
          <p className="mt-1.5 text-xs text-white/45">
            {guess ? (
              <>
                Claude&apos;s guess: <span className="text-white/70">{guess}</span>
                {post.confidence != null && (
                  <span className="ml-1 font-mono">({post.confidence.toFixed(2)})</span>
                )}
                {post.reasoning ? <> — {post.reasoning}</> : null}
              </>
            ) : (
              "Unclassified"
            )}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {TEMPLATE_DEFS.map((t) => {
          const isGuess = t.id === post.template;
          return (
            <button
              key={t.id}
              onClick={() => label(t.id)}
              disabled={!!saving}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
                isGuess
                  ? "border-eco-lightblue/40 bg-eco-lightblue/15 text-eco-lightblue hover:bg-eco-lightblue/25"
                  : "border-white/10 text-white/60 hover:border-eco-lightblue hover:text-eco-lightblue"
              }`}
            >
              {saving === t.id ? "…" : t.label}
            </button>
          );
        })}
      </div>
      <ActionProgress state={act.state} className="max-w-[220px]" />
    </div>
  );
}
