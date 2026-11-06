"use client";

import { memo } from "react";
import { reactionLane, REACTION_EMOJI } from "@/lib/reactions";
import type { ReactionDTO } from "@/lib/types";

/**
 * Emoji that drift up over the whole room.
 *
 * Each reaction mounts once (keyed by id), runs a CSS animation and then
 * sits at opacity 0 until the snapshot window drops it. No timers, no state:
 * the poll already tells us exactly which reactions are recent.
 */
function FloatingReactions({ reactions }: { reactions: ReactionDTO[] }) {
  if (!reactions.length) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
    >
      {reactions.map((r) => (
        <span
          key={r.id}
          className="reaction-float absolute bottom-24 text-3xl drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)] sm:bottom-16 sm:text-4xl"
          style={{
            left: `${6 + (reactionLane(Math.abs(r.id)) * 0.82)}%`,
            animationDelay: `${(Math.abs(r.id) % 5) * 60}ms`,
          }}
        >
          <span className="relative">
            {r.emoji}
            <span
              className="absolute -bottom-4 left-1/2 w-max -translate-x-1/2 rounded-full px-1.5 text-[9px] font-bold uppercase tracking-wider"
              style={{ color: r.userColor }}
            >
              {r.userName}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}

export default memo(FloatingReactions);

/** The tap bar. Fixed so it is reachable from every panel. */
export function ReactionBar({
  onReact,
  disabled,
}: {
  onReact: (emoji: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="pointer-events-none fixed bottom-[5.6rem] right-2.5 z-40 flex justify-end md:bottom-5 md:right-5">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-white/10 bg-[#0b0b13]/85 p-1 shadow-[0_8px_30px_rgba(0,0,0,0.5)] backdrop-blur-xl">
        {REACTION_EMOJI.map((emoji) => (
          <button
            key={emoji}
            type="button"
            disabled={disabled}
            onClick={() => onReact(emoji)}
            title={`React ${emoji}`}
            aria-label={`React ${emoji}`}
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg transition hover:scale-125 hover:bg-white/10 active:scale-95 disabled:opacity-40 sm:h-9 sm:w-9"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
