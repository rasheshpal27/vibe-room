/**
 * Adaptive network & Data Saver profile.
 *
 * Detects slow or unstable connections automatically from three real signals:
 *  1. Browser Network Information (`saveData`, `effectiveType` 2g/3g, downlink)
 *  2. Observed poll round-trip times and failures (`ewmaRttMs`)
 *  3. YouTube player re-buffering frequency (`recordBufferingStall`)
 *
 * Users can also lock Data Saver ON manually (persisted in localStorage) to
 * cut YouTube video resolution, disable parallel preloading, relax room
 * polling, and widen drift tolerances so music plays smoothly on slow links.
 */

export type DataSaverPreference = "auto" | "on";

export type NetworkReason =
  | "manual"
  | "save-data"
  | "slow-link"
  | "high-latency"
  | "buffering"
  | "healthy";

export interface NetworkProfile {
  preference: DataSaverPreference;
  /** True when user enabled Data Saver or browser sent Save-Data. */
  dataSaver: boolean;
  /** True when Data Saver is on OR the connection is slow/buffering. */
  slowNetwork: boolean;
  reason: NetworkReason;
  ewmaRttMs: number;
  recentBufferCount: number;
}

export const LS_DATA_SAVER = "vibe_data_saver";
export const SLOW_RTT_THRESHOLD_MS = 450;
export const FAST_RTT_RECOVER_MS = 240;
export const BUFFER_WINDOW_MS = 60_000;
export const SLOW_BUFFER_THRESHOLD = 2;
export const LONG_BUFFER_MS = 2500;
export const SLOW_HOLD_MIN_MS = 45_000;

interface NetworkInfoLike {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
}

export interface NetworkEvalInput {
  preference: DataSaverPreference;
  saveDataHeader?: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
  ewmaRttMs: number;
  recentBufferCount: number;
  hadLongBuffer?: boolean;
  recentFailures: number;
  wasSlow?: boolean;
  holdActive?: boolean;
}

export function computeNetworkProfile(input: NetworkEvalInput): NetworkProfile {
  const {
    preference,
    saveDataHeader = false,
    effectiveType,
    downlinkMbps,
    ewmaRttMs,
    recentBufferCount,
    hadLongBuffer = false,
    recentFailures,
    wasSlow = false,
    holdActive = false,
  } = input;

  if (preference === "on") {
    return {
      preference,
      dataSaver: true,
      slowNetwork: true,
      reason: "manual",
      ewmaRttMs,
      recentBufferCount,
    };
  }

  if (saveDataHeader) {
    return {
      preference,
      dataSaver: true,
      slowNetwork: true,
      reason: "save-data",
      ewmaRttMs,
      recentBufferCount,
    };
  }

  const slowLink =
    effectiveType === "slow-2g" ||
    effectiveType === "2g" ||
    effectiveType === "3g" ||
    (typeof downlinkMbps === "number" &&
      Number.isFinite(downlinkMbps) &&
      downlinkMbps > 0 &&
      downlinkMbps < 1.5);

  if (slowLink) {
    return {
      preference,
      dataSaver: false,
      slowNetwork: true,
      reason: "slow-link",
      ewmaRttMs,
      recentBufferCount,
    };
  }

  if (recentBufferCount >= SLOW_BUFFER_THRESHOLD || hadLongBuffer) {
    return {
      preference,
      dataSaver: false,
      slowNetwork: true,
      reason: "buffering",
      ewmaRttMs,
      recentBufferCount,
    };
  }

  const highLatency =
    ewmaRttMs >= SLOW_RTT_THRESHOLD_MS ||
    recentFailures >= 2 ||
    (wasSlow && ewmaRttMs > FAST_RTT_RECOVER_MS);

  if (highLatency || holdActive) {
    return {
      preference,
      dataSaver: false,
      slowNetwork: true,
      reason: "high-latency",
      ewmaRttMs,
      recentBufferCount,
    };
  }

  return {
    preference,
    dataSaver: false,
    slowNetwork: false,
    reason: "healthy",
    ewmaRttMs,
    recentBufferCount,
  };
}

let preference: DataSaverPreference = "auto";
let ewmaRttMs = 0;
let recentFailures = 0;
let bufferTimestamps: number[] = [];
let lastLongBufferAt = 0;
let slowHoldUntilMs = 0;
let profile: NetworkProfile = computeNetworkProfile({
  preference: "auto",
  ewmaRttMs: 0,
  recentBufferCount: 0,
  recentFailures: 0,
});

const subscribers = new Set<(p: NetworkProfile) => void>();

function readBrowserConnection(): NetworkInfoLike | null {
  if (typeof navigator === "undefined") return null;
  const conn = (navigator as Navigator & { connection?: NetworkInfoLike })
    .connection;
  return conn ?? null;
}

function recompute(nowMs: number = Date.now()) {
  bufferTimestamps = bufferTimestamps.filter(
    (t) => nowMs - t <= BUFFER_WINDOW_MS
  );
  const hadLongBuffer =
    lastLongBufferAt > 0 && nowMs - lastLongBufferAt <= BUFFER_WINDOW_MS;
  const conn = readBrowserConnection();
  const next = computeNetworkProfile({
    preference,
    saveDataHeader: !!conn?.saveData,
    effectiveType: conn?.effectiveType,
    downlinkMbps: conn?.downlink,
    ewmaRttMs: Math.round(ewmaRttMs),
    recentBufferCount: bufferTimestamps.length,
    hadLongBuffer,
    recentFailures,
    wasSlow: profile.slowNetwork,
    holdActive: nowMs < slowHoldUntilMs,
  });

  if (next.slowNetwork && !next.dataSaver && next.reason !== "healthy") {
    slowHoldUntilMs = Math.max(slowHoldUntilMs, nowMs + SLOW_HOLD_MIN_MS);
  }

  const changed =
    next.preference !== profile.preference ||
    next.dataSaver !== profile.dataSaver ||
    next.slowNetwork !== profile.slowNetwork ||
    next.reason !== profile.reason;

  profile = next;
  if (changed) {
    for (const cb of subscribers) {
      try {
        cb(profile);
      } catch {
        /* ignore bad subscriber */
      }
    }
  }
}

export function getNetworkProfile(): NetworkProfile {
  return profile;
}

export function subscribeNetworkProfile(
  cb: (p: NetworkProfile) => void
): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function initNetworkProfile(): () => void {
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem(LS_DATA_SAVER);
      if (saved === "on" || saved === "auto") {
        preference = saved;
      }
    } catch {
      /* ignore storage restrictions */
    }
  }
  recompute(Date.now());

  const conn = readBrowserConnection();
  const onChange = () => recompute(Date.now());
  conn?.addEventListener?.("change", onChange);
  return () => {
    conn?.removeEventListener?.("change", onChange);
  };
}

export function setDataSaverPreference(next: DataSaverPreference): NetworkProfile {
  preference = next;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(LS_DATA_SAVER, next);
    } catch {
      /* ignore storage restrictions */
    }
  }
  recompute(Date.now());
  return profile;
}

export function toggleDataSaver(): NetworkProfile {
  return setDataSaverPreference(preference === "on" ? "auto" : "on");
}

export function recordNetworkSample(
  rttMs: number,
  ok: boolean,
  nowMs: number = Date.now()
): NetworkProfile {
  const clamped = Number.isFinite(rttMs) ? Math.max(0, Math.min(rttMs, 8000)) : 0;
  if (clamped > 0) {
    ewmaRttMs = ewmaRttMs === 0 ? clamped : ewmaRttMs * 0.7 + clamped * 0.3;
  }
  recentFailures = ok ? 0 : recentFailures + 1;
  recompute(nowMs);
  return profile;
}

export function recordBufferingStall(
  durationMs: number = 1500,
  nowMs: number = Date.now()
): NetworkProfile {
  bufferTimestamps.push(nowMs);
  if (durationMs >= LONG_BUFFER_MS) {
    lastLongBufferAt = nowMs;
  }
  recompute(nowMs);
  return profile;
}

export function __resetNetworkProfileForTests(): void {
  preference = "auto";
  ewmaRttMs = 0;
  recentFailures = 0;
  bufferTimestamps = [];
  lastLongBufferAt = 0;
  slowHoldUntilMs = 0;
  profile = computeNetworkProfile({
    preference: "auto",
    ewmaRttMs: 0,
    recentBufferCount: 0,
    recentFailures: 0,
  });
  subscribers.clear();
}
