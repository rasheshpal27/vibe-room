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
 *  3. On slow / Data Saver links, poll cadence relaxes so room heartbeats
 *     do not compete with YouTube audio/video buffers, and normal slow polls
 *     never trigger destructive hard seeks.
 */

export type ConnectionStatus = "online" | "reconnecting" | "offline";

/** Foreground cadence on a healthy link. */
export const POLL_MS_VISIBLE = 1000;
/** Foreground cadence on a slow / Data Saver link (3x lighter). */
export const POLL_MS_SLOW = 3000;
/** Background cadence: slow enough to be polite, fast enough to catch a track change. */
export const POLL_MS_HIDDEN = 6000;
/** Background cadence on a slow / Data Saver link. */
export const POLL_MS_HIDDEN_SLOW = 10000;
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
  slow?: boolean;
  random?: number;
}): number {
  const { failures, hidden, online, slow = false } = opts;
  const random = opts.random ?? Math.random();

  if (!online) return OFFLINE_RETRY_MS;
  const baseFloor = hidden
    ? slow
      ? POLL_MS_HIDDEN_SLOW
      : POLL_MS_HIDDEN
    : slow
      ? POLL_MS_SLOW
      : POLL_MS_VISIBLE;
  if (failures <= 0) return baseFloor;

  const exponential = BACKOFF_BASE_MS * Math.pow(2, Math.min(failures - 1, 10));
  const capped = Math.min(BACKOFF_MAX_MS, exponential);
  // +/- 25% jitter.
  const jittered = capped * (0.75 + random * 0.5);
  return Math.round(Math.max(baseFloor, jittered));
}

/**
 * Only treat a gap as a real outage after 30s without a confirmed snapshot
 * (must stay well above POLL_MS_HIDDEN and slow-network poll latency so normal
 * slow connections or background tabs never re-anchor and seek every few seconds).
 */
export const FORCE_RESYNC_AFTER_MS = 30_000;
/** Only wipe clock history after a prolonged outage / sleep. */
export const CLOCK_RESET_AFTER_MS = 90_000;

export function shouldForceResyncOnRecovery(
  failures: number,
  msSinceLastSuccess: number
): boolean {
  return (
    failures >= RECONNECT_AFTER_FAILURES ||
    msSinceLastSuccess >= FORCE_RESYNC_AFTER_MS
  );
}

export function shouldResetClockOnRecovery(msSinceLastSuccess: number): boolean {
  return msSinceLastSuccess >= CLOCK_RESET_AFTER_MS;
}
