/**
 * Floating reactions.
 *
 * A reaction is just a chat row with `kind: "reaction"` — no new table, no
 * new transport. The snapshot lifts recent ones into their own list so the
 * chat log stays readable and the overlay can float them on every screen.
 */

export const REACTION_EMOJI = ["🔥", "❤️", "🎉", "😂", "🙌", "🕺"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return (
    typeof value === "string" &&
    (REACTION_EMOJI as readonly string[]).includes(value)
  );
}

/** How long a reaction stays in the snapshot (and floats on screen). */
export const REACTION_WINDOW_MS = 9000;
/** Hard cap so a spammer cannot inflate every poll. */
export const REACTION_MAX_ROWS = 24;

/** Deterministic drift so a burst of the same emoji does not stack up. */
export function reactionLane(id: number): number {
  // Golden-ratio hashing spreads consecutive ids across the full width.
  const spread = (id * 0.6180339887498949) % 1;
  return Math.round(spread * 100);
}
