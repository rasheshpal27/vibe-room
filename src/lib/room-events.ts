/**
 * A one-line event bus between the shell and the deck.
 *
 * Keyboard shortcuts, lock-screen buttons and the reconnect handler all live
 * outside the player but need to reach it. Threading four more callbacks
 * through props would re-render the whole room on every change; a window
 * event costs nothing and keeps the deck's props stable.
 */

export type RoomEvent =
  | { type: "toggle-mute" }
  | { type: "seek-by"; seconds: number }
  | { type: "focus-search" }
  /** Re-anchor hard: clock burst plus a forced seek onto the room timeline. */
  | { type: "force-resync" };

const CHANNEL = "vibe-room-event";

export function emitRoomEvent(event: RoomEvent): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<RoomEvent>(CHANNEL, { detail: event }));
}

export function onRoomEvent(handler: (event: RoomEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<RoomEvent>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(CHANNEL, listener);
  return () => window.removeEventListener(CHANNEL, listener);
}
