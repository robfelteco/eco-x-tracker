"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, ActionProgress } from "./useAction";
import { TEMPLATE_DEFS, type Template } from "@/lib/taxonomy";

// Inline template picker for a post row. Changing it re-files the post into the
// chosen template as a HUMAN-verified correction (same path as the review queue:
// POST /api/label → applyHumanLabel). That records ground truth in `labels` (so
// it also feeds the few-shot pool) and locks the post's template. Use it to fix
// a miscategorized post straight from the table without opening the review queue.
export function ReorganizeSelect({
  postId,
  current,
}: {
  postId: string;
  current: Template | null;
}) {
  const [value, setValue] = useState<Template | "">(current ?? "");
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const router = useRouter();
  const act = useAction("label");

  async function onChange(next: Template) {
    if (next === value) return;
    const prev = value;
    setValue(next);
    setState("saving");
    try {
      await act.run(async () => {
        const res = await fetch("/api/label", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId, template: next }),
        });
        if (!res.ok) throw new Error(String(res.status));
      });
      setState("done");
      setTimeout(() => router.refresh(), 350);
    } catch {
      setValue(prev); // revert the optimistic pick on failure
      setState("error");
    }
  }

  const ring =
    state === "saving"
      ? "border-eco-lightblue/40"
      : state === "done"
        ? "border-emerald-400/50"
        : state === "error"
          ? "border-red-400/50"
          : "border-white/10 hover:border-white/25";

  return (
    <div className="max-w-[150px]">
    <select
      aria-label="Reorganize into another template"
      value={value}
      disabled={state === "saving"}
      onChange={(e) => onChange(e.target.value as Template)}
      className={`max-w-[150px] rounded-md border bg-white/[0.04] px-2 py-1 text-xs text-white/75 outline-none transition disabled:opacity-60 ${ring}`}
    >
      {value === "" && (
        <option value="" disabled className="bg-[#0b0f14]">
          — choose —
        </option>
      )}
      {TEMPLATE_DEFS.map((t) => (
        <option key={t.id} value={t.id} className="bg-[#0b0f14] text-white">
          {t.label}
        </option>
      ))}
    </select>
      <ActionProgress state={act.state} />
    </div>
  );
}
