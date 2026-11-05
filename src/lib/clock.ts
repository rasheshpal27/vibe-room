/**
 * High-precision World Clock / NTP-style client synchronization utilities.
 *
 * Uses multi-sample round-trip-time (RTT) filtering anchored to the monotonic
 * clock (`performance.now()`) so local system clock jumps or single-packet network
 * spikes do not throw off cross-device song synchronization.
 */

export interface ClockSample {
  /** Client monotonic timestamp before request (ms) */
  t0Mono: number;
  /** Client monotonic timestamp after response (ms) */
  t1Mono: number;
  /** Server / World UTC epoch timestamp (ms) */
  serverUtcMs: number;
  /** Round-trip time in ms */
  rttMs: number;
  /** Estimated UTC epoch ms when performance.now() === 0 */
  utcAtMonoZero: number;
}

export interface ClockSyncState {
  /** Estimated UTC epoch ms when performance.now() === 0 */
  utcAtMonoZero: number;
  /** Offset in ms relative to local Date.now() (worldUtcMs - Date.now()) */
  offsetMs: number;
  /** Best (lowest) round-trip time observed in ms */
  bestRttMs: number;
  /** Number of valid samples collected */
  sampleCount: number;
  /** Whether at least one server/world clock sample has been applied */
  synced: boolean;
}

/**
 * Compute a single NTP-style clock sample from monotonic request/response
 * timestamps and the server's UTC millisecond timestamp.
 */
export function createClockSample(
  t0Mono: number,
  t1Mono: number,
  serverUtcMs: number
): ClockSample {
  const rttMs = Math.max(0, t1Mono - t0Mono);
  const midpointMono = t0Mono + rttMs / 2;
  const utcAtMonoZero = serverUtcMs - midpointMono;
  return {
    t0Mono,
    t1Mono,
    serverUtcMs,
    rttMs,
    utcAtMonoZero,
  };
}

/**
 * Given a history of clock samples, select the lowest-RTT subset (NTP clock
 * filter) to estimate `utcAtMonoZero` with millisecond accuracy.
 */
export function selectBestClockAnchor(
  samples: ClockSample[],
  nowWallMs: number = Date.now(),
  nowMonoMs: number = typeof performance !== "undefined" ? performance.now() : 0
): ClockSyncState {
  const valid = samples.filter(
    (s) =>
      Number.isFinite(s.t0Mono) &&
      Number.isFinite(s.t1Mono) &&
      Number.isFinite(s.serverUtcMs) &&
      s.t1Mono >= s.t0Mono
  );

  if (!valid.length) {
    return {
      utcAtMonoZero: nowWallMs - nowMonoMs,
      offsetMs: 0,
      bestRttMs: Infinity,
      sampleCount: 0,
      synced: false,
    };
  }

  // Sort by lowest RTT first (least network queuing asymmetry)
  const sorted = [...valid].sort((a, b) => a.rttMs - b.rttMs);
  const bestRttMs = sorted[0].rttMs;

  // Keep up to the 3 best samples whose RTT is within 1.5x + 15ms of the best RTT
  const threshold = bestRttMs * 1.5 + 15;
  const top = sorted.filter((s) => s.rttMs <= threshold).slice(0, 3);

  const avgUtcAtMonoZero =
    top.reduce((acc, s) => acc + s.utcAtMonoZero, 0) / top.length;
  const estimatedWorldNow = avgUtcAtMonoZero + nowMonoMs;
  const offsetMs = estimatedWorldNow - nowWallMs;

  return {
    utcAtMonoZero: avgUtcAtMonoZero,
    offsetMs,
    bestRttMs,
    sampleCount: valid.length,
    synced: true,
  };
}

/**
 * Compute the current UTC world-clock timestamp in milliseconds with sub-ms
 * monotonic precision.
 */
export function getWorldNowMs(
  state: ClockSyncState,
  nowWallMs: number = Date.now(),
  nowMonoMs: number = typeof performance !== "undefined" ? performance.now() : 0
): number {
  if (!state.synced || !Number.isFinite(state.utcAtMonoZero)) {
    return nowWallMs;
  }
  return state.utcAtMonoZero + nowMonoMs;
}

/**
 * Calculate the exact expected playback position in milliseconds and seconds
 * against the synchronized world clock.
 */
export function computeExpectedPosition(
  party: {
    isPlaying: boolean;
    positionSec: number;
    durationSec: number;
    updatedAtMs: number;
  },
  worldNowMs: number
): { positionMs: number; positionSec: number } {
  const baseMs = Math.max(0, (party.positionSec || 0) * 1000);
  const elapsedMs = party.isPlaying
    ? Math.max(0, worldNowMs - party.updatedAtMs)
    : 0;
  const rawMs = baseMs + elapsedMs;
  const maxMs =
    party.durationSec && party.durationSec > 0
      ? party.durationSec * 1000
      : Infinity;
  const positionMs = Math.min(rawMs, maxMs);
  return {
    positionMs,
    positionSec: positionMs / 1000,
  };
}
