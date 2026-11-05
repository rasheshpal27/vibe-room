"use client";

import { useEffect, useRef, useState } from "react";
import { MicVocal, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { parseLyrics } from "@/lib/lyrics";

type Lyrics = { syncedLyrics?: string; plainLyrics?: string; instrumental?: boolean };

/**
 * Inline home-page Lyrics panel (rendered directly on the main deck page, not in
 * a popup modal or separate tab, and enabled by default).
 */
export default function LyricsOverlay({
  title,
  artist,
  position,
  onClose,
}: {
  title: string;
  artist: string;
  position: number;
  onClose?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const [data, setData] = useState<Lyrics | null>(null);
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!title) return;
    const controller = new AbortController();
    setStatus("loading");
    fetch(`/api/lyrics?${new URLSearchParams({ title, artist })}`, {
      signal: controller.signal,
    })
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
  }, [title, artist, attempt]);

  const lines = parseLyrics(data?.syncedLyrics ?? "");
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) index = i;
    else break;
  }

  // Smoothly center the active lyric line inside the inline container without
  // scrolling the outer browser window.
  useEffect(() => {
    if (collapsed) return;
    const container = containerRef.current;
    const activeEl = activeRef.current;
    if (!container || !activeEl) return;
    const targetTop =
      activeEl.offsetTop -
      container.clientHeight / 2 +
      activeEl.clientHeight / 2;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }, [index, collapsed]);

  return (
    <section
      aria-labelledby="lyrics-title"
      className="glass-deep mx-auto mt-6 w-full max-w-[560px] overflow-hidden rounded-[1.8rem] border border-white/10 shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-fuchsia-300">
            <MicVocal className="h-3.5 w-3.5" />
            Live Lyrics · On Deck
          </p>
          <h3 id="lyrics-title" className="truncate text-xs font-semibold text-zinc-200">
            {title}
            {artist ? <span className="text-zinc-500"> · {artist}</span> : null}
          </h3>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {status !== "loading" && (
            <button
              type="button"
              onClick={() => {
                setStatus("loading");
                setAttempt((n) => n + 1);
              }}
              title="Reload lyrics"
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (onClose) onClose();
              else setCollapsed((c) => !c);
            }}
            aria-expanded={!collapsed}
            className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
          >
            {collapsed ? (
              <>
                Show <ChevronDown className="h-3.5 w-3.5" />
              </>
            ) : (
              <>
                Minimize <ChevronUp className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </div>
      </header>

      {!collapsed && (
        <div
          ref={containerRef}
          className="nice-scroll relative max-h-72 overflow-y-auto px-6 py-6 sm:px-8"
        >
          {status === "loading" ? (
            <p role="status" className="py-10 text-center text-sm text-zinc-400">
              Finding synced lyrics…
            </p>
          ) : lines.length ? (
            <div className="space-y-4 py-8">
              {lines.map((line, i) => {
                const isCurrent = i === index;
                const isPast = i < index;
                return (
                  <p
                    key={i}
                    ref={isCurrent ? activeRef : undefined}
                    aria-current={isCurrent ? "true" : undefined}
                    className={`font-display transition-all duration-300 ${
                      isCurrent
                        ? "scale-[1.02] text-lg font-bold leading-snug text-fuchsia-300 text-glow sm:text-xl"
                        : isPast
                          ? "text-sm font-medium leading-relaxed text-zinc-500/70"
                          : "text-sm font-semibold leading-relaxed text-zinc-400"
                    }`}
                  >
                    {line.text || "♪"}
                  </p>
                );
              })}
            </div>
          ) : data?.plainLyrics ? (
            <div className="space-y-3">
              <p className="text-[11px] uppercase tracking-widest text-zinc-500">
                Timing unavailable · plain lyrics
              </p>
              <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-200">
                {data.plainLyrics}
              </p>
            </div>
          ) : (
            <div className="py-8 text-center" role="status">
              <p className="font-display text-sm font-bold text-zinc-200">
                {data?.instrumental ? "Instrumental track" : "Lyrics unavailable"}
              </p>
              <p className=" mx-auto mt-2 max-w-sm text-xs leading-relaxed text-zinc-400">
                {data?.instrumental
                  ? "No sung lyrics for this track."
                  : "We couldn't find synced lyrics for this version, or the provider is temporarily unavailable."}
              </p>
              <button
                type="button"
                className="mt-4 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/10"
                onClick={() => {
                  setStatus("loading");
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
