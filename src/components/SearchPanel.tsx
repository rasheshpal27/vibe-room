"use client";

import { useEffect, useRef, useState } from "react";
import {
  Search,
  Plus,
  Check,
  Music4,
  X,
  PartyPopper,
  MoonStar,
  Heart,
  Flame,
  Dumbbell,
  CloudRain,
  Disc3,
  CarFront,
  Brain,
  Guitar,
  Sparkles,
  LoaderCircle,
} from "lucide-react";
import { MOODS, type Mood } from "@/lib/constants";
import { formatDuration, type SongResult } from "@/lib/types";
import type { JoinedUser } from "./EntryGate";

const MOOD_ICONS: Record<string, React.ReactNode> = {
  "party-popper": <PartyPopper className="h-5 w-5" />,
  "moon-star": <MoonStar className="h-5 w-5" />,
  heart: <Heart className="h-5 w-5" />,
  flame: <Flame className="h-5 w-5" />,
  dumbbell: <Dumbbell className="h-5 w-5" />,
  "cloud-rain": <CloudRain className="h-5 w-5" />,
  "disc-3": <Disc3 className="h-5 w-5" />,
  "car-front": <CarFront className="h-5 w-5" />,
  brain: <Brain className="h-5 w-5" />,
  guitar: <Guitar className="h-5 w-5" />,
};

export default function SearchPanel({
  me,
  refresh,
}: {
  me: JoinedUser;
  refresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SongResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeMood, setActiveMood] = useState<Mood | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const runSearch = async (q: string, mood: Mood | null) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const data = await res.json();
      if (seq !== seqRef.current) return;
      setResults(data.results ?? []);
      if (!(data.results ?? []).length) setError("No songs found. Try different words.");
    } catch {
      if (seq === seqRef.current) setError("Search is being moody. Try again.");
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      if (!activeMood) {
        setResults([]);
        setError("");
      }
      return;
    }
    setActiveMood(null);
    debounceRef.current = setTimeout(() => runSearch(q, null), 450);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const pickMood = (mood: Mood) => {
    setActiveMood(mood);
    setQuery("");
    runSearch(mood.query, mood);
  };

  const clearMood = () => {
    setActiveMood(null);
    setResults([]);
    setError("");
  };

  const add = async (song: SongResult) => {
    if (added.has(song.videoId)) return;
    setAdded((s) => new Set(s).add(song.videoId));
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: me.id, ...song }),
      });
      if (!res.ok) {
        setAdded((s) => {
          const n = new Set(s);
          n.delete(song.videoId);
          return n;
        });
        return;
      }
      await refresh();
    } catch {
      setAdded((s) => {
        const n = new Set(s);
        n.delete(song.videoId);
        return n;
      });
    }
  };

  const hasResults = results.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* search bar */}
      <div className="border-b border-white/5 p-3">
        <div className="group relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500 transition group-focus-within:text-fuchsia-300" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search any song, artist, vibe…"
            className="w-full rounded-2xl border border-white/10 bg-black/40 py-3 pl-11 pr-10 text-sm text-white outline-none transition placeholder:text-zinc-600 focus:border-fuchsia-400/50 focus:shadow-[0_0_26px_rgba(217,70,239,0.18)]"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-500 hover:bg-white/10 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {activeMood && (
          <div className="mt-2.5 flex items-center gap-2">
            <span
              className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold text-white"
              style={{ background: `linear-gradient(120deg, ${activeMood.from}, ${activeMood.to})` }}
            >
              {MOOD_ICONS[activeMood.icon]}
              {activeMood.label}
            </span>
            <button onClick={clearMood} className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-white">
              <X className="h-3 w-3" /> clear mood
            </button>
          </div>
        )}
      </div>

      <div className="nice-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {/* moods grid */}
        {!hasResults && !loading && (
          <div className="animate-fade-up">
            <p className="mb-3 flex items-center gap-2 px-1 text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">
              <Sparkles className="h-3.5 w-3.5 text-fuchsia-300" />
              pick a mood
            </p>
            <div className="grid grid-cols-2 gap-2">
              {MOODS.map((mood, i) => (
                <button
                  key={mood.id}
                  onClick={() => pickMood(mood)}
                  className="group relative overflow-hidden rounded-2xl p-4 text-left transition-transform duration-300 hover:scale-[1.03] active:scale-[0.98]"
                  style={{
                    background: `linear-gradient(135deg, ${mood.from}33, ${mood.to}22)`,
                    border: `1px solid ${mood.from}44`,
                    animationDelay: `${i * 40}ms`,
                  }}
                >
                  <div
                    className="absolute -right-5 -top-5 h-16 w-16 rounded-full opacity-40 blur-xl transition group-hover:opacity-70"
                    style={{ background: mood.from }}
                  />
                  <span className="relative block text-white/90">{MOOD_ICONS[mood.icon]}</span>
                  <span className="relative mt-2.5 block font-display text-[11px] font-bold leading-tight text-white">
                    {mood.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* loading skeletons */}
        {loading && (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="shimmer flex items-center gap-3 rounded-2xl p-2.5" style={{ animationDelay: `${i * 90}ms` }}>
                <div className="h-12 w-[84px] rounded-lg bg-white/5" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-3/4 rounded bg-white/5" />
                  <div className="h-2.5 w-1/2 rounded bg-white/5" />
                </div>
              </div>
            ))}
          </div>
        )}

        {error && !loading && (
          <p className="p-6 text-center text-sm text-zinc-500">{error}</p>
        )}

        {/* results */}
        {!loading && hasResults && (
          <div className="space-y-1.5 animate-fade-up">
            {results.map((song, i) => {
              const isAdded = added.has(song.videoId);
              return (
                <div
                  key={song.videoId}
                  className="group flex items-center gap-3 rounded-2xl border border-transparent p-2 transition hover:border-white/10 hover:bg-white/5"
                  style={{ animationDelay: `${i * 35}ms` }}
                >
                  <div className="relative h-12 w-[84px] shrink-0 overflow-hidden rounded-lg">
                    {song.thumbnail ? (
                      <img src={song.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-white/5">
                        <Music4 className="h-4 w-4 text-zinc-600" />
                      </div>
                    )}
                    <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-bold tabular-nums text-zinc-200">
                      {formatDuration(song.durationSec)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-zinc-100">{song.title}</p>
                    <p className="truncate text-[11px] text-zinc-500">{song.artist}</p>
                  </div>
                  <button
                    onClick={() => add(song)}
                    disabled={isAdded}
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-bold transition ${
                      isAdded
                        ? "bg-emerald-400/15 text-emerald-300"
                        : "bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-[0_0_18px_rgba(168,85,247,0.35)] hover:scale-110 active:scale-95"
                    }`}
                    title={isAdded ? "In the queue" : "Add to queue"}
                  >
                    {isAdded ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!hasResults && !loading && (
        <p className="border-t border-white/5 px-4 py-2.5 text-center text-[10px] uppercase tracking-[0.3em] text-zinc-600">
          powered by youtube
        </p>
      )}
    </div>
  );
}
