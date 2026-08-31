"use client";

// The "it's done" chime.
//
// Rob's ask: start a long action, go work in another tab, hear when it lands.
// So the chime fires ONLY when the tab is not being looked at. If you are
// watching the panel you already saw it finish, and a sound would just be noise
// on every click.
//
// Autoplay is the fiddly part. Chrome allows programmatic play() once the page
// has sticky activation, but Safari wants the element itself to have been
// started inside a real gesture at least once. unlock() below is called from the
// click that STARTS the action, plays the element silently, and pauses it. After
// that the deferred play() works in both, including on a backgrounded tab.

const SRC = "/sounds/action-complete.mp3";
const PREF_KEY = "eco-tracker:sound:v1";

let el: HTMLAudioElement | null = null;
let unlocked = false;

function audio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!el) {
    el = new Audio(SRC);
    el.preload = "auto";
    // The source is a game sound effect mastered loud; full volume next to a
    // quiet tab is startling.
    el.volume = 0.45;
  }
  return el;
}

export function soundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* blocked storage; the preference just does not persist */
  }
}

/**
 * Call from inside a click handler. Silently starts and stops the element so a
 * later play() is allowed. Safe to call on every click: it no-ops after the
 * first success.
 */
export function unlock(): void {
  if (unlocked) return;
  const a = audio();
  if (!a) return;
  const wasMuted = a.muted;
  a.muted = true;
  a.play()
    .then(() => {
      a.pause();
      a.currentTime = 0;
      a.muted = wasMuted;
      unlocked = true;
    })
    .catch(() => {
      a.muted = wasMuted;
      // Not unlocked. play() below will try anyway and fail quietly.
    });
}

/** True when the user is looking at something else. */
export function tabIsAway(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "hidden" || !document.hasFocus();
}

/**
 * Play the chime if the preference is on. `force` bypasses the away check, for
 * the preview button in the toggle.
 */
export function playChime(force = false): void {
  if (!soundEnabled()) return;
  if (!force && !tabIsAway()) return;
  const a = audio();
  if (!a) return;
  try {
    a.currentTime = 0;
  } catch {
    /* not seekable yet */
  }
  void a.play().catch(() => {
    /* blocked by autoplay policy; the visual state still reports completion */
  });
}
