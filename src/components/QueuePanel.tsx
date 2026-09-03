"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ListMusic, Trash2, Zap, Music4 } from "lucide-react";
import { formatDuration, type PartySnapshot } from "@/lib/types";

export default function QueuePanel({
  snap,
  isAdmin,
  adminKey,
  refresh,
  onGoDiscover,
}: {
  snap: PartySnapshot | null;
  isAdmin: boolean;
  adminKey: string;
  refresh: () => Promise<void>;
  onGoDiscover: () => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const queue = snap?.queue ?? [];
  const totalSec = queue.reduce((a, b) => a + (b.durationSec || 0), 0);

  const act = async (fn: () => Promise<Response>, id: number) => {
    setBusyId(id);
    try {
      await fn();
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const remove = (id: number) =>
    act(() => fetch(`/api/queue?id=${id}`, { method: "DELETE", headers: { "x-admin-key": adminKey } }), id);
  const move = (id: number, dir: "up" | "down") =>
    act(
      () =>
        fetch("/api/queue", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, dir, adminKey }),
        }),
      id
    );
  const playNow = (id: number) =>
    act(
      () =>
        fetch("/api/player", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "playNow", queueId: id, adminKey }),
        }),
      id
    );

  if (!queue.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5">
          <ListMusic className="h-8 w-8 text-zinc-500" strokeWidth={1.5} />
        </div>
        <p className="font-display text-sm text-zinc-300">Nothing lined up yet</p>
        <p className="max-w-[240px] font-serif text-base italic text-zinc-500">
          the queue is a blank canvas — paint it with bangers
        </p>
        <button
          onClick={onGoDiscover}
          className="mt-2 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 py-2.5 font-display text-[11px] font-bold uppercase tracking-[0.2em] text-white transition hover:shadow-[0_0_30px_rgba(217,70,239,0.35)]"
        >
          Add songs
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 py-3 text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">
        <span>up next</span>
        <span>
          {queue.length} track{queue.length > 1 ? "s" : ""} · {Math.round(totalSec / 60)} min
        </span>
      </div>
      <div className="nice-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
        {queue.map((q, i) => (
          <div
            key={q.id}
            className={`group relative flex items-center gap-3 rounded-2xl p-2.5 transition ${
              i === 0
                ? "border border-fuchsia-400/25 bg-gradient-to-r from-fuchsia-500/10 to-transparent"
                : "border border-transparent hover:bg-white/5"
            } ${busyId === q.id ? "opacity-50" : ""}`}
          >
            <span
              className={`w-6 text-center font-display text-xs font-bold ${
                i === 0 ? "text-fuchsia-300" : "text-zinc-600"
              }`}
            >
              {String(i + 1).padStart(2, "0")}
            </span>

            <div className="relative h-12 w-[84px] shrink-0 overflow-hidden rounded-lg">
              {q.thumbnail ? (
                <img src={q.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-white/5">
                  <Music4 className="h-4 w-4 text-zinc-600" />
                </div>
              )}
              {i === 0 && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                  <div className="flex h-3 items-end gap-[2px]">
                    {[0.8, 1.1, 0.6, 0.9].map((d, k) => (
                      <span key={k} className="eq-bar w-[2px] rounded-full bg-fuchsia-300" style={{ height: "100%", animationDuration: `${d}s` }} />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-zinc-100">{q.title}</p>
              <p className="truncate text-[11px] text-zinc-500">
                {q.artist ? `${q.artist} · ` : ""}by {q.addedByName}
              </p>
            </div>

            <span className="shrink-0 text-[10px] font-semibold tabular-nums text-zinc-600">
              {formatDuration(q.durationSec)}
            </span>

            {isAdmin && (
              <div className="flex shrink-0 items-center gap-0.5 opacity-100 lg:opacity-0 lg:transition lg:group-hover:opacity-100">
                <IconBtn title="Play now" onClick={() => playNow(q.id)} accent>
                  <Zap className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn title="Move up" onClick={() => move(q.id, "up")} disabled={i === 0}>
                  <ChevronUp className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn title="Move down" onClick={() => move(q.id, "down")} disabled={i === queue.length - 1}>
                  <ChevronDown className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn title="Remove" onClick={() => remove(q.id)} danger>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  danger,
  accent,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 w-7 items-center justify-center rounded-lg transition disabled:opacity-25 ${
        danger
          ? "text-zinc-500 hover:bg-red-500/15 hover:text-red-300"
          : accent
            ? "text-zinc-500 hover:bg-amber-400/15 hover:text-amber-300"
            : "text-zinc-500 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
