/**
 * A timer that survives a backgrounded tab as well as a browser allows.
 *
 * Chrome clamps `setInterval` in hidden pages to once per second, and after
 * five minutes applies "intensive throttling" (once per minute) unless the
 * page is playing audible audio — which is exactly the moment a listening
 * party needs the poll most, because the track is about to end. Timers owned
 * by a dedicated worker are throttled far less aggressively, so the ticker
 * runs there when workers are available and falls back to `setInterval`
 * when they are not (CSP, old browser, SSR).
 */

export interface Ticker {
  /** Change the cadence; takes effect on the next tick. */
  setDelay(ms: number): void;
  /** Fire immediately and restart the interval from now. */
  kick(): void;
  stop(): void;
}

const WORKER_SOURCE = `
let id = null;
let delay = 1000;
function arm() {
  if (id !== null) clearInterval(id);
  id = setInterval(function () { postMessage("tick"); }, delay);
}
onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === "start") { delay = msg.ms; arm(); }
  else if (msg.type === "stop") { if (id !== null) clearInterval(id); id = null; }
};
`;

function createWorkerTicker(onTick: () => void, delayMs: number): Ticker | null {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") return null;
  let url = "";
  try {
    url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "application/javascript" })
    );
    const worker = new Worker(url);
    worker.onmessage = () => onTick();
    worker.postMessage({ type: "start", ms: delayMs });
    let current = delayMs;
    return {
      setDelay(ms: number) {
        if (ms === current) return;
        current = ms;
        worker.postMessage({ type: "start", ms });
      },
      kick() {
        onTick();
        worker.postMessage({ type: "start", ms: current });
      },
      stop() {
        worker.postMessage({ type: "stop" });
        worker.terminate();
        URL.revokeObjectURL(url);
      },
    };
  } catch {
    if (url) URL.revokeObjectURL(url);
    return null;
  }
}

function createTimerTicker(onTick: () => void, delayMs: number): Ticker {
  let current = delayMs;
  let id = window.setInterval(onTick, current);
  const rearm = () => {
    window.clearInterval(id);
    id = window.setInterval(onTick, current);
  };
  return {
    setDelay(ms: number) {
      if (ms === current) return;
      current = ms;
      rearm();
    },
    kick() {
      onTick();
      rearm();
    },
    stop() {
      window.clearInterval(id);
    },
  };
}

export function createTicker(onTick: () => void, delayMs: number): Ticker {
  return createWorkerTicker(onTick, delayMs) ?? createTimerTicker(onTick, delayMs);
}
