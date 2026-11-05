"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseLyrics } from "@/lib/lyrics";

type Lyrics = { syncedLyrics?: string; plainLyrics?: string; instrumental?: boolean };

export default function LyricsOverlay({ title, artist, position, onClose }: {
  title: string; artist: string; position: number; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<HTMLParagraphElement>(null);
  const [data, setData] = useState<Lyrics | null>(null);
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.showModal();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/lyrics?${new URLSearchParams({ title, artist })}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unavailable");
        return response.json() as Promise<Lyrics>;
      }).then((lyrics) => {
        if (controller.signal.aborted) return;
        setData(lyrics);
        setStatus("done");
      }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [title, artist, attempt]);
  const lines = parseLyrics(data?.syncedLyrics ?? "");
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) index = i;
    else break;
  }
  useEffect(() => {
    active.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [index]);
  return createPortal(
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="lyrics-title"
      className="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none bg-[#0b0b13] p-0 text-white backdrop:bg-black">
      <div className="flex h-full flex-col bg-gradient-to-br from-violet-950/60 via-transparent to-fuchsia-950/40">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 p-6">
          <div><p className="mb-2 text-xs uppercase tracking-widest text-fuchsia-300">Lyrics · LRCLIB</p>
            <h2 id="lyrics-title" className="text-xl font-bold">{title}</h2><p className="text-zinc-400">{artist}</p></div>
          <button autoFocus onClick={onClose} aria-label="Close lyrics" className="rounded-xl border border-white/20 px-4 py-2 hover:bg-white/10">Close</button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-12 sm:px-16">
          {status === "loading" ? <p role="status">Finding lyrics…</p> : lines.length ? (
            <div className="mx-auto max-w-3xl space-y-8 pb-[35vh] pt-[20vh]">
              {lines.map((line, i) => <p key={i} ref={i === index ? active : undefined} aria-current={i === index ? "true" : undefined}
                className={`text-2xl font-bold leading-relaxed transition-colors sm:text-4xl ${i === index ? "text-fuchsia-300" : "text-zinc-500"}`}>{line.text || "♪"}</p>)}
            </div>
          ) : data?.plainLyrics ? <div className="mx-auto max-w-3xl"><p className="mb-6 text-sm text-zinc-400">Timing unavailable · unsynced lyrics</p><p className="whitespace-pre-line text-2xl leading-relaxed">{data.plainLyrics}</p></div> : (
            <div className="mx-auto mt-20 max-w-md text-center" role="status">
              <h3 className="text-2xl font-bold">{data?.instrumental ? "Instrumental track" : "Lyrics unavailable"}</h3>
              <p className="mt-4 text-zinc-400">{data?.instrumental ? "No sung lyrics for this track." : "We couldn't find lyrics for this version, or the provider is temporarily unavailable. The music keeps playing."}</p>
              <button className="mt-6 rounded-xl border border-white/20 px-5 py-3" onClick={() => { setStatus("loading"); setAttempt((n) => n + 1); }}>Try again</button>
            </div>
          )}
        </div>
      </div>
    </dialog>, document.body);
}
