/**
 * Network helpers for room mutations.
 *
 * `ended`, `duration` and `unplayable` are the three reports the room cannot
 * afford to lose: drop an `ended` on a flaky phone and the party sits on a
 * finished song until the server's 15-second overdue sweep rescues it. All
 * three are idempotent on the server (they are keyed to a queue id), so a
 * single retry costs nothing and fixes the common case of one dropped packet.
 */

/** Player actions that are safe to send twice. */
export const IDEMPOTENT_ACTIONS = ["ended", "duration", "unplayable"] as const;

export function isIdempotentAction(action: string): boolean {
  return (IDEMPOTENT_ACTIONS as readonly string[]).includes(action);
}

export const RETRY_DELAY_MS = 700;
export const POST_TIMEOUT_MS = 8000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Should this attempt be retried? Network errors (`res === null`) and 5xx
 * are worth another go; a 4xx is a decision, not an accident.
 */
export function shouldRetryResponse(res: Response | null): boolean {
  if (!res) return true;
  return res.status >= 500;
}

export async function postJson(
  url: string,
  body: unknown,
  opts: { retry?: boolean; timeoutMs?: number } = {}
): Promise<Response | null> {
  const { retry = false, timeoutMs = POST_TIMEOUT_MS } = opts;
  const attempts = retry ? 2 : 1;
  let last: Response | null = null;

  for (let i = 0; i < attempts; i++) {
    try {
      last = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      last = null;
    }
    if (!shouldRetryResponse(last)) return last;
    if (i < attempts - 1) await sleep(RETRY_DELAY_MS);
  }
  return last;
}
