/**
 * Poll cadence and reconnect policy.
 *
 * Two rules the room depends on:
 *
 *  1. A hidden tab must KEEP POLLING. YouTube happily plays audio in a
 *     background tab, but a client that stops polling never learns the track
 *     ended, so the music simply stops for that listener — and after 90s of
 *     no heartbeat they disappear from the room. Hidden tabs poll slowly
 *     instead of not at all.
 *  2. Failures back off with jitter so a room full of guests does not
 *     retry in lockstep and hammer a server that is already struggling.
 */

export type ConnectionStatus = "online" | "reconnecting" | "offline";

/** Foreground cadence. */
export const POLL_MS_VISIBLE = 1000;
/** Background cadence: slow enough to be polite, fast enough to catch a track change. */
export const POLL_MS_HIDDEN = 6000;
/** How many consecutive failures before we admit it to the user. */
export const RECONNECT_AFTER_FAILURES = 2;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 20000;
/** Offline: keep a slow heartbeat so the `online` event is not the only hope. */
export const OFFLINE_RETRY_MS = 3000;

export function connectionStatus(
  failures: number,
  online: boolean
): ConnectionStatus {
  if (!online) return "offline";
  return failures >= RECONNECT_AFTER_FAILURES ? "reconnecting" : "online";
}

/**
 * Delay before the next poll.
 *
 * `random` is injectable so the jitter is testable; it should be in [0, 1).
 */
export function nextPollDelayMs(opts: {
  failures: number;
  hidden: boolean;
  online: boolean;
  random?: number;
}): number {
  const { failures, hidden, online } = opts;
  const random = opts.random ?? Math.random();

  if (!online) return OFFLINE_RETRY_MS;
  if (failures <= 0) return hidden ? POLL_MS_HIDDEN : POLL_MS_VISIBLE;

  const exponential = BACKOFF_BASE_MS * Math.pow(2, Math.min(failures - 1, 10));
  const capped = Math.min(BACKOFF_MAX_MS, exponential);
  // +/- 25% jitter.
  const jittered = capped * (0.75 + random * 0.5);
  const floor = hidden ? POLL_MS_HIDDEN : POLL_MS_VISIBLE;
  return Math.round(Math.max(floor, jittered));
}

/**
 * After this long without a successful poll the local playhead is a guess,
 * not a fact: the deck should re-anchor hard (clock burst + seek) rather than
 * drift back in.
 */
export const FORCE_RESYNC_AFTER_MS = 4000;

export function shouldForceResyncOnRecovery(
  failures: number,
  msSinceLastSuccess: number
): boolean {
  return (
    failures >= RECONNECT_AFTER_FAILURES ||
    msSinceLastSuccess >= FORCE_RESYNC_AFTER_MS
  );
}
