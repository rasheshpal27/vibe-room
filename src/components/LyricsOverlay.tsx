"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MicVocal, RefreshCw, Music4, Shuffle, Check } from "lucide-react";
import { parseLyrics, type LyricLine } from "@/lib/lyrics";
import { subscribePlayhead } from "@/lib/playhead";

type Lyrics = {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
  unavailable?: boolean;
  alternatives?: number;
  index?: number;
  matched?: {
    trackName: string;
    artistName: string;
    duration: number | null;
  } | null;
};

/** Index of the last line whose timestamp has already passed. */
function lineIndexAt(lines: LyricLine[], seconds: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= seconds) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Full-height Lyrics column — the left pane of Lyrics | Deck | Queue.
 *
 * Deliberately chrome-less: no card, no border, no backdrop. The words sit
 * straight on the room's aurora, so they can use the full width of the
 * column at a readable size. The page itself never scrolls; only this list
 * moves, keeping the active line centred.
 *
 * The playhead arrives through a subscription instead of a prop so the deck
 * can publish it many times a second without re-rendering the whole party.
 */
export default function LyricsOverlay({
  title,
  artist,
  durationSec,
}: {
  title?: string;
  artist?: string;
  durationSec?: number;
  onClose?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const [data, setData] = useState<Lyrics | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    title ? "loading" : "idle"
  );
  const [attempt, setAttempt] = useState(0);
  const [alt, setAlt] = useState(0);
  const [pad, setPad] = useState(96);
  const [index, setIndex] = useState(-1);

  useEffect(() => {
    if (!title) {
      setData(null);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    const params = new URLSearchParams({ title, artist: artist ?? "" });
    if (durationSec && durationSec > 0) {
      params.set("duration", String(Math.round(durationSec)));
    }
    if (alt > 0) params.set("alt", String(alt));

    fetch(`/api/lyrics?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        return response.json() as Promise<Lyrics>;
      })
      .then((lyrics) => {
        if (controller.signal.aborted) return;
        setData(lyrics);
        setStatus("done");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [title, artist, durationSec, attempt, alt]);

  const lines = useMemo(
    () => parseLyrics(data?.syncedLyrics ?? ""),
    [data?.syncedLyrics]
  );
  /* Follow the deck's playhead. This fires ~10x/second but only ever calls
     setState when the highlighted line actually changes. */
  useEffect(() => {
    const current = lines;
    // subscribePlayhead replays the current position immediately, so the
    // first callback below also does the initial highlight.
    return subscribePlayhead((sec) => {
      const next = lineIndexAt(current, sec);
      setIndex((prev) => (prev === next ? prev : next));
    });
  }, [lines]);

  const centerActive = useCallback((smooth: boolean) => {
    const container = containerRef.current;
    const activeEl = activeRef.current;
    if (!container || !activeEl) return;
    const targetTop =
      activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // Padding is half the panel height so the first/last line can still centre,
  // whatever size this column happens to be. The observer also fires when the
  // panel is revealed again on a phone, which re-centres it instantly.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const h = container.clientHeight;
      if (h <= 0) return;
      setPad(Math.max(56, h / 2 - 34));
      centerActive(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [status, centerActive]);

  // Smoothly centre the active lyric inside this panel — never the page.
  useEffect(() => {
    centerActive(true);
  }, [index, centerActive]);

  const matched = data?.matched ?? null;
  const altCount = data?.alternatives ?? 0;
  const hasContent = lines.length > 0 || !!data?.plainLyrics;

  return (
    <section
      aria-labelledby="lyrics-title"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-start justify-between gap-2 px-1 pb-2 sm:px-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-fuchsia-300/90">
            <MicVocal className="h-3.5 w-3.5" />
            Live Lyrics
          </p>
          <h3
            id="lyrics-title"
            className="mt-0.5 truncate text-xs font-semibold text-zinc-300"
          >
            {title ? (
              <>
                {title}
                {artist ? <span className="text-zinc-500"> · {artist}</span> : null}
              </>
            ) : (
              <span className="text-zinc-500">Waiting for track…</span>
            )}
          </h3>
          {matched && status === "done" && hasContent && (
            <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-zinc-500">
              <Check className="h-2.5 w-2.5 shrink-0 text-emerald-400/80" />
              matched {matched.trackName}
              {matched.artistName ? ` · ${matched.artistName}` : ""}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {title && status === "done" && altCount > 1 && (
            <button
              type="button"
              onClick={() => setAlt((n) => n + 1)}
              title="Wrong lyrics? Try the next matching version"
              className="flex h-8 items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-2.5 text-[10px] font-semibold text-zinc-300 backdrop-blur-sm transition hover:bg-white/10 hover:text-white"
            >
              <Shuffle className="h-3 w-3" />
              Wrong?
            </button>
          )}
          {title && status !== "loading" && (
            <button
              type="button"
              onClick={() => {
                setStatus("loading");
                setAttempt((n) => n + 1);
              }}
              title="Reload lyrics"
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-400 backdrop-blur-sm transition hover:bg-white/10 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      <div
        ref={containerRef}
        className="nice-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 sm:px-2"
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent 0%, #000 8%, #000 90%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0%, #000 8%, #000 90%, transparent 100%)",
        }}
      >
        {!title || status === "idle" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5">
              <Music4 className="h-7 w-7 text-zinc-500" strokeWidth={1.5} />
            </div>
            <p className="font-display text-sm font-bold text-zinc-300">
              Lyrics ready
            </p>
            <p className="max-w-[260px] font-serif text-base italic text-zinc-500">
              synced lyrics appear here automatically as soon as a song plays
            </p>
          </div>
        ) : status === "loading" ? (
          <div className="flex h-full items-center justify-center">
            <p role="status" className="text-sm text-zinc-400">
              Finding synced lyrics…
            </p>
          </div>
        ) : lines.length ? (
          <div
            className="space-y-4 lg:space-y-5"
            style={{ paddingTop: pad, paddingBottom: pad }}
          >
            {lines.map((line, i) => {
              const isCurrent = i === index;
              const isPast = i < index;
              return (
                <p
                  key={i}
                  ref={isCurrent ? activeRef : undefined}
                  aria-current={isCurrent ? "true" : undefined}
                  className={`font-display origin-left transition-all duration-300 [text-shadow:0_2px_18px_rgba(0,0,0,0.75)] ${
                    isCurrent
                      ? "scale-[1.015] text-2xl font-bold leading-snug text-white text-glow lg:text-3xl"
                      : isPast
                        ? "text-lg font-medium leading-snug text-zinc-500/60 lg:text-xl"
                        : "text-lg font-semibold leading-snug text-zinc-300/80 lg:text-xl"
                  }`}
                >
                  {line.text || "♪"}
                </p>
              );
            })}
          </div>
        ) : data?.plainLyrics ? (
          <div className="space-y-3 py-5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              Timing unavailable · plain lyrics
            </p>
            <p className="whitespace-pre-line text-lg leading-relaxed text-zinc-200 [text-shadow:0_2px_18px_rgba(0,0,0,0.75)]">
              {data.plainLyrics}
            </p>
          </div>
        ) : (
          <div
            className="flex h-full flex-col items-center justify-center py-8 text-center"
            role="status"
          >
            <p className="font-display text-base font-bold text-zinc-200">
              {data?.instrumental ? "Instrumental track" : "Lyrics unavailable"}
            </p>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-zinc-400">
              {data?.instrumental
                ? "No sung lyrics for this track."
                : status === "error"
                  ? "The lyrics provider is temporarily unavailable."
                  : "We couldn't find lyrics for this version of the song."}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/10"
                onClick={() => {
                  setStatus("loading");
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
              {altCount > 1 && (
                <button
                  type="button"
                  className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/10"
                  onClick={() => setAlt((n) => n + 1)}
                >
                  Next match
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
