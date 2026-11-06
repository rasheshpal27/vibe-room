/**
 * Token-bucket rate limiting for the write endpoints.
 *
 * Brute-forcing the party password used to be free: /api/auth would happily
 * check thousands of guesses a second. The bucket maths is pure so it can be
 * unit tested; the store is a plain Map, which means the limit is per server
 * instance. That is intentionally modest — it is a speed bump that turns an
 * offline-speed attack into a trickle, not a distributed quota service.
 */

export interface BucketState {
  tokens: number;
  updatedAtMs: number;
}

export interface LimitRule {
  /** Burst size. */
  capacity: number;
  /** Steady-state refill speed. */
  refillPerSec: number;
}

export interface LimitVerdict {
  allowed: boolean;
  state: BucketState;
  /** Seconds until one more token exists (0 when allowed). */
  retryAfterSec: number;
  remaining: number;
}

export const RULES = {
  /** Joining / claiming host: 8 tries, then one every 7.5s. */
  auth: { capacity: 8, refillPerSec: 1 / 7.5 },
  /** Chat: a burst of 12 then ~1/s sustained. */
  chat: { capacity: 12, refillPerSec: 1 },
  /** Reactions are cheap but spammable. */
  reaction: { capacity: 15, refillPerSec: 1.5 },
  /** Adding songs: 20 burst, one every 2s after. */
  queue: { capacity: 20, refillPerSec: 0.5 },
} satisfies Record<string, LimitRule>;

/** Pure bucket step: refill by elapsed time, then try to spend one token. */
export function takeToken(
  prev: BucketState | undefined,
  rule: LimitRule,
  nowMs: number
): LimitVerdict {
  const base: BucketState = prev ?? {
    tokens: rule.capacity,
    updatedAtMs: nowMs,
  };
  const elapsedSec = Math.max(0, (nowMs - base.updatedAtMs) / 1000);
  const refilled = Math.min(
    rule.capacity,
    base.tokens + elapsedSec * rule.refillPerSec
  );

  if (refilled >= 1) {
    const state = { tokens: refilled - 1, updatedAtMs: nowMs };
    return {
      allowed: true,
      state,
      retryAfterSec: 0,
      remaining: Math.floor(state.tokens),
    };
  }

  const deficit = 1 - refilled;
  const retryAfterSec = Math.max(
    1,
    Math.ceil(deficit / Math.max(rule.refillPerSec, 1e-6))
  );
  return {
    allowed: false,
    state: { tokens: refilled, updatedAtMs: nowMs },
    retryAfterSec,
    remaining: 0,
  };
}

const buckets = new Map<string, BucketState>();
const MAX_TRACKED = 5000;

/** Drop buckets that have refilled completely — they carry no information. */
function prune(nowMs: number, rule: LimitRule) {
  if (buckets.size <= MAX_TRACKED) return;
  for (const [key, state] of buckets) {
    const elapsedSec = (nowMs - state.updatedAtMs) / 1000;
    if (state.tokens + elapsedSec * rule.refillPerSec >= rule.capacity) {
      buckets.delete(key);
    }
  }
}

export function rateLimit(
  key: string,
  rule: LimitRule,
  nowMs: number = Date.now()
): LimitVerdict {
  const verdict = takeToken(buckets.get(key), rule, nowMs);
  buckets.set(key, verdict.state);
  prune(nowMs, rule);
  return verdict;
}

/** Only for tests. */
export function resetRateLimits() {
  buckets.clear();
}

/**
 * Best-effort client identity. Netlify and most proxies put the real address
 * in one of these; everything collapses to "unknown" behind a proxy that
 * forwards none of them, which still limits the whole room together.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-nf-client-connection-ip");
  if (forwarded) return forwarded.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export function limitKey(scope: string, headers: Headers, extra = ""): string {
  return `${scope}:${clientIp(headers)}${extra ? `:${extra}` : ""}`;
}
