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


/* ------------------------------------------------------------------ *
 * Crossfade
 *
 * Two songs have to overlap for the music never to stop, and every guest
 * has to hear the same overlap. The room timeline therefore moves to the
 * next track `CROSSFADE_SEC` before the current one runs out: the incoming
 * song starts at position 0 on the second deck while the outgoing song
 * plays its last seconds on the first one, fading out.
 * ------------------------------------------------------------------ */

/** Length of the audio overlap between two songs, in seconds. */
export const CROSSFADE_SEC = 4;
/** Fade applied when a track change was *not* a natural ending (skip, delete). */
export const SKIP_FADE_MS = 2500;
/** Legacy alias kept for the hard-cut path (no second deck available). */
export const QUICK_FADE_MS = 900;
/**
 * How long the outgoing song holds at full volume while the incoming deck
 * gets going. A primed deck starts in ~100ms; a cold one (an unexpected
 * skip) can take a second, and the old song has to cover that gap rather
 * than let the room fall silent.
 */
export const FADE_HOLD_MAX_MS = 1800;
/** Start buffering the next song this many seconds before the current ends. */
export const PRELOAD_LEAD_SEC = 18;
/** Never crossfade clips shorter than this — it would eat the whole track. */
export const MIN_CROSSFADE_TRACK_SEC = 45;
/**
 * How early an `ended` report may legitimately arrive. One crossfade plus
 * slack for poll latency and a slightly wrong stored duration.
 */
export const END_REPORT_TOLERANCE_SEC = CROSSFADE_SEC + 4;

/* ------------------------------------------------------------------ *
 * Soft drift correction
 *
 * The room is in sync when every deck sits on the same world-clock
 * position. The old correction was a single blunt instrument: once the
 * drift passed 300ms for two readings, `seekTo()` — which flushes the
 * decoder and produces an audible hiccup, several times a song on a
 * phone with a lazy timer.
 *
 * HTML5 playback rate changes are pitch-preserving, so a 3% nudge is
 * completely inaudible: at 1.03x a deck claws back 30ms of lag every
 * second. Small drift is therefore *steered* out, and the hard seek is
 * reserved for gaps too large to steer (a tab that was asleep, a
 * reconnect, a manual scrub).
 * ------------------------------------------------------------------ */

/** Below this nobody can hear the difference — do nothing at all. */
export const DRIFT_DEADBAND_SEC = 0.3;
/** Above this, steering would take longer than the song. Jump instead. */
export const DRIFT_HARD_SEEK_SEC = 2.5;
/** Playback rates used to steer. Both are inaudible and pitch-preserving. */
export const RATE_CATCH_UP = 1.03;
export const RATE_EASE_OFF = 0.97;
export const RATE_NORMAL = 1;
/** Once inside this band the deck is handed back to 1.0x. */
export const DRIFT_SETTLED_SEC = 0.12;
/** Float comparison slack for rates. */
const RATE_EPSILON = 0.001;

export type DriftCorrection =
  | { kind: "none" }
  | { kind: "rate"; rate: number }
  | { kind: "seek" };

function sameRate(a: number, b: number) {
  return Math.abs(a - b) < RATE_EPSILON;
}

/**
 * Decide how to answer the current drift.
 *
 * `driftSec` is `player - expected`: positive means this deck is AHEAD of
 * the room and must slow down. `rateSupported` is false when the player
 * refused a fractional rate, in which case the old seek-only ladder is
 * used unchanged.
 */
export function planDriftCorrection(input: {
  driftSec: number;
  currentRate: number;
  strikes: number;
  seekCooledDown: boolean;
  force: boolean;
  rateSupported: boolean;
  strikesNeeded?: number;
}): DriftCorrection {
  const {
    driftSec,
    currentRate,
    strikes,
    seekCooledDown,
    force,
    rateSupported,
  } = input;
  const strikesNeeded = input.strikesNeeded ?? 2;

  if (force) return { kind: "seek" };
  if (!Number.isFinite(driftSec)) return { kind: "none" };

  const distance = Math.abs(driftSec);
  const struckOut = strikes >= strikesNeeded && seekCooledDown;

  // Too far gone to steer.
  if (distance >= DRIFT_HARD_SEEK_SEC && struckOut) return { kind: "seek" };

  if (!rateSupported) {
    if (distance > DRIFT_DEADBAND_SEC && struckOut) return { kind: "seek" };
    return { kind: "none" };
  }

  const steering = !sameRate(currentRate, RATE_NORMAL);

  // Back on the beat: hand the deck back to normal speed.
  if (steering && distance <= DRIFT_SETTLED_SEC) {
    return { kind: "rate", rate: RATE_NORMAL };
  }

  if (distance > DRIFT_DEADBAND_SEC) {
    const wanted = driftSec > 0 ? RATE_EASE_OFF : RATE_CATCH_UP;
    return sameRate(currentRate, wanted)
      ? { kind: "none" }
      : { kind: "rate", rate: wanted };
  }

  // Inside the deadband but not yet settled: keep steering, say nothing.
  return { kind: "none" };
}

/** Seconds of steering needed to erase `driftSec` at the given rate. */
export function steeringSecondsFor(driftSec: number, rate: number): number {
  const delta = Math.abs(rate - RATE_NORMAL);
  if (delta < RATE_EPSILON) return Infinity;
  return Math.abs(driftSec) / delta;
}

/**
 * Equal-power crossfade gains. Linear ramps dip in the middle (the two
 * signals are uncorrelated, so their powers add, not their amplitudes);
 * sin/cos keeps the perceived loudness constant across the overlap.
 */
export function crossfadeGains(progress: number): {
  incoming: number;
  outgoing: number;
} {
  const t = Math.min(1, Math.max(0, progress));
  return {
    incoming: Math.sin((t * Math.PI) / 2),
    outgoing: Math.cos((t * Math.PI) / 2),
  };
}

/**
 * How much time is really left on this client's deck.
 *
 * The room timeline is authoritative for *position*, but its duration is
 * whatever the search provider claimed. When the real video is shorter the
 * room would never reach the crossfade window before the audio stops, so
 * the player's own clock — ground truth for when sound ends — wins.
 */
export function effectiveRemainingSec(
  serverRemainingSec: number,
  playerRemainingSec?: number | null
): number {
  const candidates = [serverRemainingSec, playerRemainingSec].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  if (!candidates.length) return Infinity;
  return Math.min(...candidates);
}

/**
 * Should this client move the room on early so the next song can overlap?
 *
 * Deliberately independent of whether the preload finished: the overlap
 * only needs the *outgoing* deck to still have audio left, which is
 * exactly what moving the timeline early guarantees. A cold incoming deck
 * costs a slightly later fade-in, never silence.
 */
export function shouldArmEarlyEnd(input: {
  remainingSec: number;
  hasNext: boolean;
  isPlaying: boolean;
  durationSec: number;
  alreadyReported: boolean;
}): boolean {
  if (!input.hasNext || !input.isPlaying || input.alreadyReported) return false;
  if (!(input.durationSec >= MIN_CROSSFADE_TRACK_SEC)) return false;
  return input.remainingSec <= CROSSFADE_SEC;
}

/**
 * Guard for `POST /api/player {action:"ended"}`.
 *
 * Clients report the end of a track themselves, and with crossfade they do
 * it a few seconds early on purpose. A report that arrives far too early
 * (stale client, wrong clock, bad metadata) must not cut the song off for
 * the whole room. The player's own measured duration wins when it is
 * shorter than the stored one — that is the "metadata lied" case, and it is
 * exactly when the room would otherwise stall until the watchdog.
 */
export function shouldAcceptEndReport(input: {
  elapsedSec: number;
  stateDurationSec: number;
  clientDurationSec?: number | null;
  toleranceSec?: number;
}): boolean {
  const tolerance = input.toleranceSec ?? END_REPORT_TOLERANCE_SEC;
  const stored = Number.isFinite(input.stateDurationSec)
    ? input.stateDurationSec
    : 0;
  const client =
    typeof input.clientDurationSec === "number" &&
    Number.isFinite(input.clientDurationSec) &&
    input.clientDurationSec >= 20
      ? input.clientDurationSec
      : null;

  const effective =
    client !== null && stored > 0 ? Math.min(stored, client) : client ?? stored;

  // Unknown length: trust the client, the watchdog is the only alternative.
  if (!effective || effective <= 0) return true;
  return input.elapsedSec >= effective - tolerance;
}
