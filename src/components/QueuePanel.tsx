"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ListMusic,
  Trash2,
  Zap,
  Music4,
  History,
  SkipForward,
  RotateCcw,
  Plus,
  Check,
  Sparkles,
  RefreshCw,
  AudioLines,
} from "lucide-react";
import { SUGGESTED_SONGS } from "@/lib/constants";
import { buildSongSuggestions } from "@/lib/suggestions";
import { formatDuration, type PartySnapshot, type SongResult } from "@/lib/types";
import type { JoinedUser } from "./EntryGate";

export default function QueuePanel({
  snap,
  me,
  isAdmin,
  adminKey,
  refresh,
  onGoDiscover,
}: {
  snap: PartySnapshot | null;
  me?: JoinedUser;
  isAdmin: boolean;
  adminKey: string;
  refresh: () => Promise<void>;
  onGoDiscover: () => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [remoteSuggestions, setRemoteSuggestions] = useState<SongResult[]>([]);
  const [suggestionSeed, setSuggestionSeed] = useState(0);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [scrolledUpInHistory, setScrolledUpInHistory] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeAnchorRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);
  const lastActiveQidRef = useRef<number | null | undefined>(undefined);

  const queue = snap?.queue ?? [];
  const history = snap?.history ?? [];
  const nowPlaying = snap?.nowPlaying ?? null;
  const totalSec = queue.reduce((a, b) => a + (b.durationSec || 0), 0);

  // Exclude songs currently playing or already queued from suggestions
  const excludedVideoIds = useMemo(() => {
    const ids = new Set<string>();
    if (nowPlaying?.videoId) ids.add(nowPlaying.videoId);
    for (const q of queue) ids.add(q.videoId);
    return ids;
  }, [nowPlaying?.videoId, queue]);

  // Fetch contextual suggestions from /api/suggestions when current track changes or user refreshes
  useEffect(() => {
    let cancelled = false;
    setLoadingSuggestions(true);
    const params = new URLSearchParams();
    if (nowPlaying?.artist) params.set("artist", nowPlaying.artist);
    if (nowPlaying?.title) params.set("title", nowPlaying.title);
    const excludeArr = Array.from(excludedVideoIds);
    if (excludeArr.length) params.set("exclude", excludeArr.join(","));

    fetch(`/api/suggestions?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data.suggestions)) {
          setRemoteSuggestions(data.suggestions);
        }
      })
      .catch(() => {
        /* fallback to curated suggestions */
      })
      .finally(() => {
        if (!cancelled) setLoadingSuggestions(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nowPlaying?.videoId, nowPlaying?.artist, nowPlaying?.title, suggestionSeed, excludedVideoIds]);

  const suggestions = useMemo(() => {
    const rotatedCurated = [
      ...SUGGESTED_SONGS.slice(suggestionSeed % SUGGESTED_SONGS.length),
      ...SUGGESTED_SONGS.slice(0, suggestionSeed % SUGGESTED_SONGS.length),
    ];
    return buildSongSuggestions(
      [...remoteSuggestions, ...rotatedCurated],
      excludedVideoIds,
      5
    );
  }, [remoteSuggestions, suggestionSeed, excludedVideoIds]);

  // Anchor scroll position at the active/upcoming section so played songs sit
  // above and the user can scroll up to inspect played history.
  const scrollToActive = useCallback((smooth = false) => {
    const container = scrollRef.current;
    const anchor = activeAnchorRef.current;
    if (!container || !anchor) return;
    userScrolledUpRef.current = false;
    setScrolledUpInHistory(false);
    container.scrollTo({
      top: Math.max(0, anchor.offsetTop - 8),
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  const scrollToHistoryTop = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    userScrolledUpRef.current = true;
    setScrolledUpInHistory(true);
    container.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const currentQid = nowPlaying?.queueId ?? null;
    if (lastActiveQidRef.current === undefined) {
      lastActiveQidRef.current = currentQid;
      if (history.length > 0) {
        requestAnimationFrame(() => scrollToActive(false));
      }
      return;
    }
    if (lastActiveQidRef.current !== currentQid) {
      lastActiveQidRef.current = currentQid;
      if (!userScrolledUpRef.current && history.length > 0) {
        requestAnimationFrame(() => scrollToActive(true));
      }
    }
  }, [nowPlaying?.queueId, history.length, scrollToActive]);

  const handleScroll = () => {
    const container = scrollRef.current;
    const anchor = activeAnchorRef.current;
    if (!container || !anchor || history.length === 0) return;
    const isViewingHistory = container.scrollTop + 24 < anchor.offsetTop;
    userScrolledUpRef.current = isViewingHistory;
    setScrolledUpInHistory(isViewingHistory);
  };

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
    act(
      () =>
        fetch(`/api/queue?id=${id}`, {
          method: "DELETE",
          headers: { "x-admin-key": adminKey },
        }),
      id
    );
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

  const addSongToQueue = async (song: SongResult) => {
    if (!me?.id || addedIds.has(song.videoId)) return;
    setAddedIds((prev) => new Set(prev).add(song.videoId));
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: me.id, ...song }),
      });
      if (!res.ok) {
        setAddedIds((prev) => {
          const n = new Set(prev);
          n.delete(song.videoId);
          return n;
        });
        return;
      }
      await refresh();
    } catch {
      setAddedIds((prev) => {
        const n = new Set(prev);
        n.delete(song.videoId);
        return n;
      });
    }
  };

  const hasAnyQueueContent =
    history.length > 0 || !!nowPlaying || queue.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Header bar with Played History scroll-up toggle & Up Next summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">
        <div className="flex items-center gap-2">
          <span>queue</span>
          {history.length > 0 && (
            <button
              type="button"
              onClick={() =>
                scrolledUpInHistory ? scrollToActive(true) : scrollToHistoryTop()
              }
              className="inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-300 transition hover:bg-violet-500/20"
              title="Scroll up to view all played songs in this session"
            >
              <History className="h-3 w-3" />
              {scrolledUpInHistory
                ? "↓ Jump to Live"
                : `↑ ${history.length} Played`}
            </button>
          )}
        </div>
        <span>
          {queue.length} up next · {Math.round(totalSec / 60)} min
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="nice-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3"
      >
        {/* ---------- 1. PLAYED SONGS HISTORY (scroll up to see) ---------- */}
        {history.length > 0 && (
          <div className="space-y-1.5 pb-2">
            <div className="flex items-center justify-between px-2 py-1 text-[9px] font-bold uppercase tracking-[0.25em] text-zinc-500">
              <span className="flex items-center gap-1.5">
                <History className="h-3 w-3 text-zinc-400" />
                Played earlier ({history.length})
              </span>
              <span>scroll down for live queue</span>
            </div>

            {history.map((h, idx) => {
              const isReadded = addedIds.has(h.videoId);
              return (
                <div
                  key={`played-${h.id}`}
                  className="group relative flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-white/5 bg-white/[0.02] p-2 opacity-75 transition hover:border-white/10 hover:bg-white/5 hover:opacity-100"
                >
                  <span
                    className="flex w-5 shrink-0 items-center justify-center text-[10px] font-bold text-zinc-600"
                    title={`Played #${idx + 1}`}
                  >
                    <History className="h-3.5 w-3.5" />
                  </span>

                  <div className="relative h-11 w-[68px] shrink-0 overflow-hidden rounded-lg">
                    {h.thumbnail ? (
                      <img
                        src={h.thumbnail}
                        alt=""
                        className="h-full w-full object-cover grayscale-[35%]"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-white/5">
                        <Music4 className="h-4 w-4 text-zinc-600" />
                      </div>
                    )}
                    <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-zinc-300">
                      Played
                    </span>
                  </div>

                  <div className="min-w-0 flex-1 basis-[7rem]">
                    <p
                      className="line-clamp-2 text-xs font-semibold leading-snug text-zinc-300"
                      title={h.title}
                    >
                      {h.title}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-zinc-500">
                      <span className="tabular-nums">
                        {formatDuration(h.durationSec)}
                      </span>
                      {h.artist ? ` · ${h.artist}` : ""} · by {h.addedByName}
                    </p>
                  </div>

                  <div className="row-actions flex w-full shrink-0 items-center justify-end gap-1 sm:w-auto">
                    {me && (
                      <IconBtn
                        title={isReadded ? "Added back to queue" : "Queue again"}
                        onClick={() => addSongToQueue(h)}
                        disabled={isReadded}
                        accent
                      >
                        {isReadded ? (
                          <Check className="h-3.5 w-3.5 text-emerald-300" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </IconBtn>
                    )}
                    {isAdmin && (
                      <IconBtn
                        title="Play now"
                        onClick={() => playNow(h.id)}
                        accent
                      >
                        <Zap className="h-3.5 w-3.5" />
                      </IconBtn>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ---------- 2. ACTIVE ANCHOR: NOW PLAYING ---------- */}
        <div ref={activeAnchorRef} />

        {nowPlaying && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-2 text-[9px] font-bold uppercase tracking-[0.25em] text-cyan-300">
              <span className="flex items-center gap-1.5">
                <AudioLines className="h-3 w-3" />
                Now Playing
              </span>
              <span>on deck</span>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-cyan-400/30 bg-gradient-to-r from-cyan-500/15 via-violet-500/10 to-transparent p-2.5">
              <span
                className="flex w-5 shrink-0 items-center justify-center text-cyan-300"
                title="Currently playing"
              >
                <AudioLines className="h-4 w-4 animate-pulse" />
              </span>

              <div className="relative h-12 w-[76px] shrink-0 overflow-hidden rounded-lg">
                {nowPlaying.thumbnail ? (
                  <img
                    src={nowPlaying.thumbnail}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-white/5">
                    <Music4 className="h-4 w-4 text-zinc-600" />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                  <div className="flex h-3.5 items-end gap-[2px]">
                    {[0.8, 1.1, 0.6, 0.9].map((d, k) => (
                      <span
                        key={k}
                        className="eq-bar w-[2.5px] rounded-full bg-cyan-300"
                        style={{ height: "100%", animationDuration: `${d}s` }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* The badge sits on its own line above the title: inline it
                  would steal the width of this narrow row and leave the song
                  name truncated to a few characters. */}
              <div className="min-w-0 flex-1">
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-400/15 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-cyan-200">
                  <AudioLines className="h-2.5 w-2.5" />
                  Playing now
                </span>
                <p
                  className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-white"
                  title={nowPlaying.title}
                >
                  {nowPlaying.title}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                  <span className="tabular-nums text-cyan-200/80">
                    {formatDuration(nowPlaying.durationSec)}
                  </span>
                  {nowPlaying.artist ? ` · ${nowPlaying.artist}` : ""} · by{" "}
                  {nowPlaying.addedByName}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ---------- 3. UP NEXT QUEUE (with Next Song Playing icon on #1) ---------- */}
        {queue.length > 0 ? (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between px-2 text-[9px] font-bold uppercase tracking-[0.25em] text-fuchsia-300/90">
              <span className="flex items-center gap-1.5">
                <SkipForward className="h-3 w-3" />
                Up Next ({queue.length})
              </span>
            </div>

            {queue.map((q, i) => {
              const isNextPlaying = i === 0;
              return (
                <div
                  key={q.id}
                  className={`group relative flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl p-2.5 transition ${
                    isNextPlaying
                      ? "border border-fuchsia-400/30 bg-fuchsia-500/[0.07]"
                      : "border border-transparent hover:bg-white/5"
                  } ${busyId === q.id ? "opacity-50" : ""}`}
                >
                  {/* Queue position. The first row is only tinted, never
                      animated: an equalizer here read as "this is playing". */}
                  <span
                    className={`w-5 shrink-0 text-center font-display text-xs font-bold tabular-nums ${
                      isNextPlaying ? "text-fuchsia-300" : "text-zinc-600"
                    }`}
                    title={isNextPlaying ? "Plays next" : `Queue position ${i + 1}`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>

                  <div className="relative h-12 w-[76px] shrink-0 overflow-hidden rounded-lg">
                    {q.thumbnail ? (
                      <img
                        src={q.thumbnail}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-white/5">
                        <Music4 className="h-4 w-4 text-zinc-600" />
                      </div>
                    )}
                    {isNextPlaying && (
                      <span className="absolute bottom-1 left-1 rounded bg-fuchsia-500/85 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white">
                        Up next
                      </span>
                    )}
                  </div>

                  {/* The badge gets its own line above the title. Inline, a
                      shrink-0 pill eats this narrow row and the song name is
                      truncated away to nothing. */}
                  <div className="min-w-0 flex-1 basis-[7rem]">
                    {isNextPlaying && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-fuchsia-400/40 bg-fuchsia-500/20 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-fuchsia-200">
                        <SkipForward className="h-2.5 w-2.5" />
                        Plays next
                      </span>
                    )}
                    <p
                      className={`line-clamp-2 text-[13px] font-semibold leading-snug text-zinc-100 ${
                        isNextPlaying ? "mt-1" : ""
                      }`}
                      title={q.title}
                    >
                      {q.title}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                      <span className="tabular-nums">
                        {formatDuration(q.durationSec)}
                      </span>
                      {q.artist ? ` · ${q.artist}` : ""} · by {q.addedByName}
                    </p>
                  </div>

                  {isAdmin && (
                    <div className="row-actions flex w-full shrink-0 items-center justify-end gap-0.5 sm:w-auto">
                      <IconBtn
                        title="Play now"
                        onClick={() => playNow(q.id)}
                        accent
                      >
                        <Zap className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn
                        title="Move up"
                        onClick={() => move(q.id, "up")}
                        disabled={i === 0}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn
                        title="Move down"
                        onClick={() => move(q.id, "down")}
                        disabled={i === queue.length - 1}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn
                        title="Remove"
                        onClick={() => remove(q.id)}
                        danger
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconBtn>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          !hasAnyQueueContent && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/5 bg-white/[0.02] p-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5">
                <ListMusic className="h-6 w-6 text-zinc-500" strokeWidth={1.5} />
              </div>
              <p className="font-display text-xs text-zinc-300">
                Nothing lined up yet
              </p>
              <p className="max-w-[220px] font-serif text-sm italic text-zinc-500">
                pick from the suggestions below or search any track
              </p>
              <button
                onClick={onGoDiscover}
                className="mt-1 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 font-display text-[10px] font-bold uppercase tracking-[0.2em] text-white transition hover:shadow-[0_0_24px_rgba(217,70,239,0.35)]"
              >
                Search songs
              </button>
            </div>
          )
        )}

        {/* ---------- 4. USER SUGGESTIONS TO ADD SONGS TO QUEUE ---------- */}
        <div className="mt-4 space-y-2 border-t border-white/10 pt-4">
          <div className="flex items-center justify-between px-2">
            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-violet-300">
              <Sparkles className="h-3.5 w-3.5 text-fuchsia-300" />
              Suggested for the Queue
            </span>
            <button
              type="button"
              onClick={() => setSuggestionSeed((s) => s + 3)}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold text-zinc-400 transition hover:bg-white/10 hover:text-white"
              title="Refresh song suggestions"
            >
              <RefreshCw
                className={`h-3 w-3 ${loadingSuggestions ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>

          <div className="space-y-1.5">
            {suggestions.map((song) => {
              const isAdded = addedIds.has(song.videoId);
              return (
                <div
                  key={`sug-${song.videoId}`}
                  className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.03] p-2 transition hover:border-fuchsia-400/30 hover:bg-white/[0.06]"
                >
                  <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-lg">
                    {song.thumbnail ? (
                      <img
                        src={song.thumbnail}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-white/5">
                        <Music4 className="h-4 w-4 text-zinc-600" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p
                      className="line-clamp-2 text-xs font-semibold leading-snug text-zinc-100"
                      title={song.title}
                    >
                      {song.title}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-zinc-400">
                      {song.artist} · {formatDuration(song.durationSec)}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => addSongToQueue(song)}
                    disabled={isAdded || !me}
                    className={`flex h-8 shrink-0 items-center gap-1 rounded-xl px-3 text-[10px] font-bold uppercase tracking-wider transition ${
                      isAdded
                        ? "bg-emerald-400/15 text-emerald-300"
                        : "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_16px_rgba(168,85,247,0.3)] hover:scale-105 active:scale-95"
                    }`}
                    title={isAdded ? "Added to queue" : "Add suggested song to queue"}
                  >
                    {isAdded ? (
                      <>
                        <Check className="h-3.5 w-3.5" /> Added
                      </>
                    ) : (
                      <>
                        <Plus className="h-3.5 w-3.5" /> Add
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
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
