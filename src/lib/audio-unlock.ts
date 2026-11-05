/**
 * Global "sound is allowed" tracker.
 *
 * Browsers only let a video play *with sound* once the document has received a
 * user gesture (sticky activation). The party flow always has one — typing a
 * name and pressing "Join the party" — but a plain page reload (auto re-join
 * from localStorage) starts with no activation at all.
 *
 * This module remembers, for the lifetime of the document, whether sound is
 * allowed so the deck can:
 *   - unmute automatically (no "tap for sound" needed) in the normal flow, and
 *   - start muted-but-in-sync after a cold reload, then unmute on the very
 *     first interaction anywhere in the app.
 *
 * Listeners are installed once, as early as the app boots, so even the click
 * that submits the entry gate counts.
 */

let unlocked = false;
let installed = false;
const subscribers = new Set<() => void>();

/** Gestures that grant sticky activation in every major browser. */
const GESTURES = [
  "pointerdown",
  "mousedown",
  "touchstart",
  "touchend",
  "keydown",
  "click",
] as const;

type GestureTarget = {
  addEventListener: (
    type: string,
    listener: () => void,
    options?: unknown
  ) => void;
};

/** True when this document is allowed to play audible media. */
export function isAudioUnlocked(): boolean {
  if (unlocked) return true;
  if (typeof navigator !== "undefined") {
    const ua = (
      navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }
    ).userActivation;
    if (ua?.hasBeenActive) {
      unlocked = true;
      return true;
    }
  }
  return false;
}

/** Flag the document as interacted with (call from real user handlers). */
export function markAudioUnlocked(): void {
  if (unlocked) return;
  unlocked = true;
  for (const cb of [...subscribers]) {
    try {
      cb();
    } catch {
      /* a bad subscriber must never break playback */
    }
  }
}

/** Subscribe to the moment sound becomes allowed. Returns an unsubscribe fn. */
export function onAudioUnlock(cb: () => void): () => void {
  subscribers.add(cb);
  if (unlocked) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
  return () => subscribers.delete(cb);
}

/**
 * Install the global gesture listeners exactly once. Safe to call repeatedly
 * and safe to call before the player exists.
 */
export function installAudioUnlockListeners(target?: GestureTarget): void {
  if (installed) return;
  const host =
    target ?? (typeof window !== "undefined" ? (window as GestureTarget) : null);
  if (!host) return;
  installed = true;
  const handler = () => markAudioUnlocked();
  for (const type of GESTURES) {
    host.addEventListener(type, handler, { capture: true, passive: true });
  }
}

/** Test-only reset. */
export function __resetAudioUnlockForTests(): void {
  unlocked = false;
  installed = false;
  subscribers.clear();
}
