"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIONS, expectedMs, recordDuration, progressFraction, remainingMs, formatDuration,
  isShortAction, SHORT_ACTION_MS, type ActionKind,
} from "@/lib/actionEta";
import { playChime, unlock, soundEnabled, setSoundEnabled } from "./notifySound";

// One wrapper for every button in the app that waits on the backend.
//
// Before this, a click flipped a label to "Drafting…" and then the UI sat
// motionless for the length of a full agent turn. Nothing said whether the
// request was alive, and nothing said how long to wait. Now the same click gets
// a bar that moves against a learned estimate, and a chime if you have gone to
// another tab by the time it lands.

export interface ActionState {
  kind: ActionKind;
  pending: boolean;
  /** 0..0.99 while running. Never 1 until the work is actually done. */
  fraction: number;
  elapsedMs: number;
  expectedMs: number;
  /** Past the estimate, so the label switches to "taking longer than usual". */
  overrun: boolean;
  /**
   * Resolved once per run, not per render: isShortAction() reads localStorage,
   * and the bar re-renders eight times a second while it is up.
   */
  short: boolean;
}

export interface UseAction {
  state: ActionState;
  pending: boolean;
  /**
   * Wrap the async work. Returns whatever the callback returns, or undefined if
   * it threw; the throw is re-raised so existing try/catch/finally in callers
   * keeps working unchanged.
   */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

const TICK_MS = 120;

export function useAction(kind: ActionKind): UseAction {
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Read once per run, not per render: expectedMs() hits localStorage, and the
  // estimate must not shift under the bar while it is drawing.
  const expected = useRef(ACTIONS[kind].defaultMs);
  const short = useRef(ACTIONS[kind].defaultMs < SHORT_ACTION_MS);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => setElapsed(Date.now() - startedAt.current), TICK_MS);
    return () => window.clearInterval(id);
  }, [pending]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      // Inside the click, so the browser still counts this as a user gesture.
      unlock();
      expected.current = expectedMs(kind);
      short.current = isShortAction(kind);
      startedAt.current = Date.now();
      setElapsed(0);
      setPending(true);
      try {
        const out = await fn();
        const took = Date.now() - startedAt.current;
        recordDuration(kind, took);
        // Quick actions never chime. A save that lands in 400ms does not need
        // announcing, and labelling a queue would turn into a slot machine.
        if (!short.current) playChime();
        return out;
      } finally {
        setPending(false);
      }
    },
    [kind],
  );

  const exp = expected.current;
  return {
    pending,
    run,
    state: {
      kind,
      pending,
      fraction: pending ? progressFraction(elapsed, exp) : 0,
      elapsedMs: elapsed,
      expectedMs: exp,
      overrun: pending && elapsed > exp,
      short: short.current,
    },
  };
}

// ---------------------------------------------------------------------------
// The bar.
// ---------------------------------------------------------------------------

/**
 * Renders nothing when idle, so it can sit unconditionally under any button.
 *
 * Short actions get an indeterminate pulse instead of a bar: at 1.2s a
 * determinate bar is a flash, which reads as a glitch rather than as progress.
 */
export function ActionProgress({ state, className = "" }: { state: ActionState; className?: string }) {
  if (!state.pending) return null;

  const def = ACTIONS[state.kind];
  const left = remainingMs(state.elapsedMs, state.expectedMs);

  if (state.short) {
    return (
      <div className={`mt-1.5 h-0.5 overflow-hidden rounded-full bg-white/[0.07] ${className}`}>
        <div className="h-full w-1/3 animate-[eco-indeterminate_1.1s_ease-in-out_infinite] rounded-full bg-eco-lightblue/70" />
      </div>
    );
  }

  return (
    <div className={`mt-2 ${className}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3 font-mono text-[10px] tracking-wide">
        <span className="text-eco-lightblue/85">
          {def.verb}
          <span className="ml-1 text-white/30">{formatDuration(state.elapsedMs)}</span>
        </span>
        <span className={state.overrun ? "text-amber-300/75" : "text-white/35"}>
          {left ? `~${formatDuration(left)} left` : "taking longer than usual"}
        </span>
      </div>

      <div
        className="h-1 overflow-hidden rounded-full bg-white/[0.07]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(state.fraction * 100)}
        aria-label={def.verb}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-out ${
            state.overrun ? "bg-amber-300/70" : "bg-eco-lightblue"
          }`}
          style={{ width: `${(state.fraction * 100).toFixed(1)}%` }}
        />
      </div>

      {def.note && <p className="mt-1 text-[10px] leading-snug text-white/30">{def.note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preference.
// ---------------------------------------------------------------------------

/**
 * Lives in the sidebar. Reads the stored preference after mount rather than
 * during render: localStorage does not exist on the server, and seeding state
 * from it directly would mismatch the server-rendered markup.
 */
export function SoundToggle() {
  const [on, setOn] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setOn(soundEnabled());
    setReady(true);
  }, []);

  function toggle() {
    const next = !on;
    setOn(next);
    setSoundEnabled(next);
    // Turning it on plays the sound once, forced past the away check. Otherwise
    // the only way to hear it is to leave and wait, which is a bad way to find
    // out your volume is muted.
    if (next) {
      unlock();
      window.setTimeout(() => playChime(true), 60);
    }
  }

  return (
    <button
      onClick={toggle}
      title={
        on
          ? "Chime when a long action finishes while you are on another tab. Click to mute, or to hear it now."
          : "Muted. Click to turn the completion chime back on."
      }
      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition hover:bg-white/[0.04] ${
        ready && on ? "text-white/55" : "text-white/30"
      }`}
    >
      <span className="truncate">Completion chime</span>
      <span className="ml-2 font-mono text-[10px] uppercase tracking-wider">{ready && on ? "on" : "off"}</span>
    </button>
  );
}
