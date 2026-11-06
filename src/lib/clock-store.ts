/**
 * One shared world-clock anchor for the whole page.
 *
 * The deck used to own its own sample array and only fed it from /api/time
 * bursts. Every room poll already carries `serverNow`, so each one is a free
 * RTT sample — they land here too, which keeps the anchor fresh between
 * bursts and makes a reconnect re-converge almost immediately.
 */

import {
  createClockSample,
  getWorldNowMs,
  selectBestClockAnchor,
  type ClockSample,
  type ClockSyncState,
} from "./clock";

const MAX_SAMPLES = 12;

function monoNow(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

function emptyState(): ClockSyncState {
  return {
    utcAtMonoZero: Date.now() - monoNow(),
    offsetMs: 0,
    bestRttMs: Infinity,
    sampleCount: 0,
    synced: false,
  };
}

let samples: ClockSample[] = [];
let state: ClockSyncState = emptyState();
const listeners = new Set<(s: ClockSyncState) => void>();

function publish() {
  for (const fn of listeners) fn(state);
}

/**
 * Record one round trip. `t0Mono`/`t1Mono` are `performance.now()` readings
 * taken immediately before and after the request.
 */
export function addClockSample(
  t0Mono: number,
  t1Mono: number,
  serverUtcMs: number
): ClockSyncState {
  if (!Number.isFinite(serverUtcMs) || serverUtcMs <= 0) return state;
  const sample = createClockSample(t0Mono, t1Mono, serverUtcMs);
  // A wildly slow response says more about the network than the clock.
  if (sample.rttMs > 4000) return state;
  samples = [...samples.slice(-(MAX_SAMPLES - 1)), sample];
  state = selectBestClockAnchor(samples, Date.now(), monoNow());
  publish();
  return state;
}

/**
 * Coarse anchor from a snapshot body (no RTT information). Only used before
 * the first real sample lands, so a fresh tab is never wildly off.
 */
export function seedClockFromServerNow(serverNowMs: number): ClockSyncState {
  if (state.synced || !Number.isFinite(serverNowMs)) return state;
  const mono = monoNow();
  state = {
    utcAtMonoZero: serverNowMs - mono,
    offsetMs: serverNowMs - Date.now(),
    bestRttMs: Infinity,
    sampleCount: 1,
    synced: false,
  };
  publish();
  return state;
}

/**
 * Throw away the sample history. After a long disconnect (or a laptop waking
 * from sleep) the old samples describe a clock that no longer exists.
 */
export function resetClockSamples() {
  samples = [];
  state = emptyState();
  publish();
}

export function getClockState(): ClockSyncState {
  return state;
}

export function worldNowMs(): number {
  return getWorldNowMs(state, Date.now(), monoNow());
}

export function subscribeClock(fn: (s: ClockSyncState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
