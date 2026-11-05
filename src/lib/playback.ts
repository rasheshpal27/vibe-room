/**
 * Self-healing playback policy.
 *
 * Every failure mode we have seen on a song change (YouTube embed errors, a
 * load that silently never starts, an iframe that was throttled while hidden,
 * autoplay blocked by the browser) is recovered automatically here — the user
 * should never have to refresh the page.
 */

export type PlayerErrorKind =
  /** 101 / 150 — the uploader disabled embedded playback for this video. */
  | "embed-blocked"
  /** 100 — video removed / private. */
  | "missing"
  /** 2 / 5 / anything else — usually a transient client-side hiccup. */
  | "transient";

export type RecoveryStep =
  /** Re-issue loadVideoById on the existing player. */
  | "reload"
  /** Destroy + recreate the iframe in place (what a page refresh used to do). */
  | "rebuild"
  /** Recreate muted so blocked autoplay can still start and stay in sync. */
  | "rebuild-muted"
  /** Tell the server this video cannot play anywhere so the party moves on. */
  | "report-unplayable";

export interface RecoveryPlan {
  step: RecoveryStep;
  delayMs: number;
  /** Show the manual recovery card while the automatic retry keeps running. */
  surface: boolean;
}

/** How long a track may sit in a non-playing state before we heal it. */
export const STALL_GRACE_MS = 3500;
/** Grace for a brand new load (decoder + network warm-up). */
export const LOAD_GRACE_MS = 2600;
/** Background retry cadence once the recovery card is visible. */
export const BACKGROUND_RETRY_MS = 8000;

export function classifyPlayerError(code: number): PlayerErrorKind {
  if (code === 101 || code === 150) return "embed-blocked";
  if (code === 100) return "missing";
  return "transient";
}

/**
 * Escalating recovery ladder. `attempt` is 0 for the first failure of the
 * current track and resets as soon as playback becomes healthy again.
 */
export function planRecovery(
  kind: PlayerErrorKind,
  attempt: number
): RecoveryPlan {
  if (kind === "embed-blocked" || kind === "missing") {
    // Video-level problems are identical for every guest: retry once (the code
    // is occasionally reported for a stale load) and then skip it for the room.
    if (attempt <= 0) return { step: "reload", delayMs: 300, surface: false };
    if (attempt === 1) return { step: "rebuild", delayMs: 600, surface: false };
    return {
      step: "report-unplayable",
      delayMs: 400,
      surface: attempt > 2,
    };
  }

  if (attempt <= 0) return { step: "reload", delayMs: 350, surface: false };
  if (attempt === 1) return { step: "rebuild", delayMs: 700, surface: false };
  if (attempt === 2)
    return { step: "rebuild-muted", delayMs: 1200, surface: false };
  // Keep healing forever in the background, but let the user retry/skip too.
  return { step: "rebuild", delayMs: BACKGROUND_RETRY_MS, surface: true };
}

/**
 * Decide whether a track that *should* be playing is actually stuck.
 * `playerState` is a YouTube IFrame API state (-1, 0, 1, 2, 3, 5).
 */
export function shouldHealStall(opts: {
  shouldPlay: boolean;
  playerState: number;
  msSinceHealthy: number;
  recoveryPending: boolean;
  graceMs?: number;
}): boolean {
  const { shouldPlay, playerState, msSinceHealthy, recoveryPending } = opts;
  const graceMs = opts.graceMs ?? STALL_GRACE_MS;
  if (!shouldPlay || recoveryPending) return false;
  // PLAYING (1) and BUFFERING (3) are healthy; everything else is suspicious.
  if (playerState === 1 || playerState === 3) return false;
  return msSinceHealthy > graceMs;
}

/** A load is considered failed when the player never picked up the new video. */
export function shouldRetryLoad(opts: {
  expectedVideoId: string;
  actualVideoId: string | null | undefined;
  playerState: number;
  shouldPlay: boolean;
  msSinceLoad: number;
  graceMs?: number;
}): boolean {
  const graceMs = opts.graceMs ?? LOAD_GRACE_MS;
  if (opts.msSinceLoad < graceMs) return false;
  if (opts.actualVideoId && opts.actualVideoId !== opts.expectedVideoId) {
    return true;
  }
  if (!opts.shouldPlay) return false;
  return opts.playerState !== 1 && opts.playerState !== 3;
}
