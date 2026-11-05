/**
 * Tiny playhead broadcast channel.
 *
 * The deck knows the world-clock position several times a second. Lifting
 * that into React state re-rendered the entire party shell (deck + lyrics +
 * queue + chat) 10x/second, which is what made the UI feel janky and made
 * scrolling/typing stutter. Components that care subscribe here instead and
 * re-render only when something they display actually changes.
 */

let position = 0;
const subscribers = new Set<(sec: number) => void>();

export function setPlayhead(sec: number): void {
  position = Number.isFinite(sec) ? sec : 0;
  for (const cb of subscribers) {
    try {
      cb(position);
    } catch {
      /* a bad subscriber must never break playback */
    }
  }
}

export function getPlayhead(): number {
  return position;
}

export function subscribePlayhead(cb: (sec: number) => void): () => void {
  subscribers.add(cb);
  try {
    cb(position);
  } catch {
    /* replaying the current position must never break the subscriber */
  }
  return () => {
    subscribers.delete(cb);
  };
}
