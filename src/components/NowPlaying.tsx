"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
  Disc3,
  Sparkles,
  Signal,
  UserRound,
  AlertTriangle,
  ExternalLink,
  LoaderCircle,
} from "lucide-react";
import { createPlayer, YT_STATE, type YTPlayer } from "@/lib/yt-loader";
import { formatDuration, type PartySnapshot } from "@/lib/types";

export default function NowPlaying({
  snap,
  isAdmin,
  onPlayerAction,
  onGoDiscover,
}: {
  snap: PartySnapshot | null;
  isAdmin: boolean;
  onPlayerAction: (action: string, extra?: Record<string, unknown>) => Promise<void>;
  onGoDiscover: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);
  const appliedQidRef = useRef<number | null>(null);
  const offsetRef = useRef(0); // serverNow - Date.now()
  const snapRef = useRef<PartySnapshot | null>(null);
  snapRef.current = snap;

  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [displayPos, setDisplayPos] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [playerProblem, setPlayerProblem] = useState("");
  // optimistic transport state (cleared as soon as the server confirms)
  const [uiPlaying, setUiPlaying] = useState<boolean | null>(null);
  // queueId currently loaded into the player — drives the "switching" overlay
  const [loadedQid, setLoadedQid] = useState<number | null>(null);
  const busyRef = useRef(false);
  const lastServerUpdateRef = useRef(0);
  const scrubbingRef = useRef(false);
  const creatingRef = useRef(false);

  /* ---------- compute expected position ---------- */
  const expectedPos = useCallback(() => {
    const s = snapRef.current;
    if (!s) return 0;
    const drift = s.party.isPlaying
      ? Math.max(0, s.serverNow - s.party.updatedAtMs) / 1000
      : 0;
    return s.party.positionSec + drift;
  }, []);

  /* ---------- sync player with server ---------- */
  const sync = useCallback(() => {
    const player = playerRef.current;
    const s = snapRef.current;
    if (!player || !readyRef.current || !s) return;

    const np = s.nowPlaying;
    const p = s.party;
    offsetRef.current = s.serverNow - Date.now();
    const expected = expectedPos();

    try {
      if (np && np.videoId) {
        if (appliedQidRef.current !== np.queueId) {
          appliedQidRef.current = np.queueId;
          setLoadedQid(np.queueId);
          setPlayerProblem("");
          player.loadVideoById({ videoId: np.videoId, startSeconds: expected });
          if (!p.isPlaying) setTimeout(() => player.pauseVideo(), 400);
          return;
        }
        const cur = player.getCurrentTime();
        if (Number.isFinite(cur) && Math.abs(cur - expected) > 1.0) {
          player.seekTo(expected, true);
        }
        const st = player.getPlayerState();
        if (p.isPlaying && st !== YT_STATE.PLAYING && st !== YT_STATE.BUFFERING) {
          player.playVideo();
        } else if (!p.isPlaying && (st === YT_STATE.PLAYING || st === YT_STATE.BUFFERING)) {
          player.pauseVideo();
        }
      } else if (appliedQidRef.current !== null) {
        appliedQidRef.current = null;
        setLoadedQid(null);
        player.stopVideo();
      }
    } catch {
      /* player mid-transition */
    }
  }, [expectedPos]);

  /* ---------- create the player (once the container exists) ---------- */
  const mountPlayer = useCallback(() => {
    const el = mountRef.current;
    if (!el || playerRef.current || creatingRef.current) return;
    creatingRef.current = true;
    createPlayer(el, {
      onReady: (p) => {
        playerRef.current = p;
        readyRef.current = true;
        p.setVolume(80);
        setReady(true);
        sync();
      },
      onStateChange: (state) => {
        if (state === YT_STATE.ENDED) {
          const s = snapRef.current;
          const qid = appliedQidRef.current;
          if (s?.nowPlaying && qid) {
            fetch("/api/player", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "ended", queueId: qid }),
            }).catch(() => undefined);
          }
        }
      },
      onError: (code) => {
        const friendly = code === 101 || code === 150
          ? "This YouTube video does not allow embedded playback. Skip it or choose another result."
          : "YouTube could not play this track here. Try another version of the song.";
        setPlayerProblem(friendly);
      },
    })
      .catch((err) => {
        playerRef.current = null;
        setPlayerProblem(err instanceof Error ? err.message : "YouTube player could not start.");
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [sync]);

  // The player container only exists once a track is showing, so (re)try
  // mounting whenever a track appears or changes. This fixes the "first song
  // queued into an empty room never loads" hang.
  useEffect(() => {
    mountPlayer();
  }, [snap?.nowPlaying?.queueId, snap?.nowPlaying?.videoId, mountPlayer]);

  // If the deck is emptied (reset / end party) the container unmounts, so drop
  // the dead player reference and let the next track re-create it fresh.
  useEffect(() => {
    if (snap?.nowPlaying) return;
    if (playerRef.current || readyRef.current) {
      try { playerRef.current?.destroy(); } catch { /* ignore */ }
      playerRef.current = null;
      readyRef.current = false;
      appliedQidRef.current = null;
      setReady(false);
      setLoadedQid(null);
    }
  }, [snap?.nowPlaying]);

  // keep the player tightly synced with the server
  useEffect(() => {
    const t = setInterval(sync, 1000);
    return () => clearInterval(t);
  }, [sync]);

  useEffect(() => {
    sync();
  }, [snap, sync]);

  // When a fresh server state arrives, stop overriding with optimistic UI.
  useEffect(() => {
    if (!snap) return;
    if (lastServerUpdateRef.current !== snap.party.updatedAtMs) {
      lastServerUpdateRef.current = snap.party.updatedAtMs;
      setUiPlaying(null);
    }
  }, [snap]);

  useEffect(() => {
    if (!snap?.nowPlaying || ready) return;
    const t = window.setTimeout(() => {
      if (!readyRef.current) {
        setPlayerProblem(
          "The synced YouTube player is taking too long to load. This can happen with browser privacy settings, ad blockers, or some networks."
        );
      }
    }, 6000);
    return () => window.clearTimeout(t);
  }, [snap?.nowPlaying, ready]);

  /* ---------- smooth local progress ---------- */
  useEffect(() => {
    const t = setInterval(() => {
      const s = snapRef.current;
      if (!s || !s.nowPlaying) {
        setDisplayPos(0);
        return;
      }
      if (scrubbingRef.current) return; // don't fight the host's drag
      const drift = s.party.isPlaying
        ? Math.max(0, Date.now() + offsetRef.current - s.party.updatedAtMs) / 1000
        : 0;
      const pos = s.party.positionSec + drift;
      const max = s.party.durationSec || Infinity;
      setDisplayPos(Math.min(pos, max));
    }, 250);
    return () => clearInterval(t);
  }, []);

  const enableSound = () => {
    const p = playerRef.current;
    if (!p) return;
    const pos = expectedPos();
    try {
      p.unMute();
      p.setVolume(volume || 80);
      p.seekTo(pos, true);
      p.playVideo();
      setMuted(false);
      setSoundEnabled(true);
    } catch {
      // YouTube may still be buffering; the next sync tick will retry.
      setSoundEnabled(true);
    }
  };

  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) {
      p.unMute();
      p.setVolume(volume);
      p.playVideo();
      setMuted(false);
      setSoundEnabled(true);
    } else {
      p.mute();
      setMuted(true);
    }
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    const p = playerRef.current;
    if (!p) return;
    p.setVolume(v);
    if (v === 0) {
      p.mute();
      setMuted(true);
    } else {
      p.unMute();
      p.playVideo();
      setMuted(false);
      setSoundEnabled(true);
    }
  };

  const adminTransport = async (action: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    // Apply the change locally right away for an instant, app-like feel.
    try {
      if (action === "pause") {
        setUiPlaying(false);
        try { playerRef.current?.pauseVideo(); } catch { /* ignore */ }
      } else if (action === "resume") {
        setUiPlaying(true);
        setSoundEnabled(true);
        const p = playerRef.current;
        if (p) {
          try { p.seekTo(displayPos, true); p.playVideo(); } catch { /* ignore */ }
        }
      } else if (action === "skip") {
        setLoadedQid(-1);
        try { playerRef.current?.stopVideo(); } catch { /* ignore */ }
      }
    } catch {
      /* ignore */
    }

    try {
      if (action === "pause") await onPlayerAction("pause", { positionSec: displayPos });
      else if (action === "resume") await onPlayerAction("resume", { positionSec: displayPos });
      else await onPlayerAction(action);
    } catch {
      // revert optimistic UI — the next poll will reconcile everything else
      if (action === "skip") setLoadedQid(snapRef.current?.nowPlaying?.queueId ?? null);
      setUiPlaying(null);
    } finally {
      busyRef.current = false;
    }
  };

  const seekLocal = (sec: number) => {
    scrubbingRef.current = true;
    setDisplayPos(sec);
    try { playerRef.current?.seekTo(sec, true); } catch { /* ignore */ }
  };

  const commitSeek = (sec: number) => {
    scrubbingRef.current = false;
    onPlayerAction("seek", { positionSec: sec }).catch(() => undefined);
  };

  const np = snap?.nowPlaying ?? null;
  const duration = snap?.party.durationSec ?? 0;
  const isPlaying = uiPlaying ?? (!!snap?.party.isPlaying && !!np);
  const progress = duration > 0 ? Math.min(1, displayPos / duration) : 0;
  const switching = !!np && loadedQid !== np.queueId;

  const handleTilt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 10;
    const y = ((e.clientY - r.top) / r.height - 0.5) * -10;
    setTilt({ x: y, y: x });
  };

  /* =================== EMPTY STATE =================== */
  if (!np) {
    return (
      <div className="glass-deep relative mx-auto flex aspect-square w-full max-w-[560px] flex-col items-center justify-center overflow-hidden rounded-[2.4rem] p-8 text-center animate-fade-up">
        <div className="vinyl animate-spin-slow absolute h-[120%] w-[120%] rounded-full opacity-20" />
        <div className="relative z-10">
          <div className="mx-auto mb-6 flex h-20 w-20 animate-float-y items-center justify-center rounded-3xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20">
            <Disc3 className="h-10 w-10 animate-spin-slow text-violet-300" strokeWidth={1.4} />
          </div>
          <h2 className="font-display text-2xl font-bold text-white sm:text-3xl">
            The deck is waiting
          </h2>
          <p className="mx-auto mt-3 max-w-xs font-serif text-lg italic text-zinc-400">
            be the one who drops the first track
          </p>
          <button
            onClick={onGoDiscover}
            className="group mt-8 inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 px-6 py-3.5 font-display text-xs font-bold uppercase tracking-[0.25em] text-white transition hover:shadow-[0_0_40px_rgba(217,70,239,0.4)]"
          >
            <Sparkles className="h-4 w-4" />
            Find a song
          </button>
        </div>
      </div>
    );
  }

  /* =================== POSTER =================== */
  return (
    <div className="animate-fade-up">
      {/* poster */}
      <div
        className="relative mx-auto w-full max-w-[560px]"
        style={{ perspective: "1200px" }}
        onMouseMove={handleTilt}
        onMouseLeave={() => setTilt({ x: 0, y: 0 })}
      >
        {/* ambient glow from artwork */}
        <div
          className="absolute -inset-10 -z-10 rounded-[3rem] opacity-50 blur-3xl saturate-150"
          style={{
            backgroundImage: `url(${np.thumbnail})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />

        <div
          className="poster-ring rounded-[2.4rem] p-[3px] transition-transform duration-200 ease-out"
          style={{
            ["--p" as string]: progress,
            transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          }}
        >
          <div className="relative aspect-square w-full overflow-hidden rounded-[2.25rem] bg-black shadow-[0_50px_140px_rgba(0,0,0,0.8)]">
            {/* the actual player — the living poster */}
            <div ref={hostRef} className="absolute inset-0 [&>div]:h-full [&>div]:w-full">
              <div ref={mountRef} className="h-full w-full" />
            </div>

            {/* cinematic overlays */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/45" />
            <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background:repeating-linear-gradient(0deg,transparent_0_2px,#fff_2px_3px)]" />

            {/* top strip */}
            <div className="absolute left-0 right-0 top-0 flex items-start justify-between p-5">
              {isPlaying ? (
                <span className="animate-pulse-ring flex items-center gap-2 rounded-full border border-red-400/40 bg-black/60 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-red-300 backdrop-blur-md">
                  <Signal className="h-3.5 w-3.5" /> live
                </span>
              ) : (
                <span className="flex items-center gap-2 rounded-full border border-white/15 bg-black/60 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-300 backdrop-blur-md">
                  <Pause className="h-3 w-3" /> paused
                </span>
              )}

              {/* equalizer */}
              <div className={`flex h-6 items-end gap-[3px] ${isPlaying ? "" : "eq-paused"}`}>
                {[0.9, 0.5, 1.1, 0.7, 1.3, 0.6, 1].map((d, i) => (
                  <span
                    key={i}
                    className="eq-bar w-[3px] rounded-full bg-gradient-to-t from-fuchsia-400 to-cyan-300"
                    style={{ height: "100%", animationDuration: `${d}s` }}
                  />
                ))}
              </div>
            </div>

            {/* track switching / loading overlay */}
            {switching && (
              <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/50">
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/60 px-5 py-3.5 backdrop-blur-md">
                  <LoaderCircle className="h-5 w-5 animate-spin text-fuchsia-300" />
                  <span className="font-display text-xs font-bold uppercase tracking-[0.25em] text-white">
                    loading track…
                  </span>
                </div>
              </div>
            )}

            {/* browser/mobile autoplay protection: users must tap once for audio */}
            {isPlaying && ready && !soundEnabled && !playerProblem && !switching && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/25 backdrop-blur-[1px]">
                <button
                  onClick={enableSound}
                  className="group flex items-center gap-3 rounded-2xl border border-white/15 bg-black/70 px-6 py-4 font-display text-xs font-bold uppercase tracking-[0.25em] text-white shadow-[0_0_45px_rgba(168,85,247,0.45)] transition hover:scale-105 hover:border-fuchsia-300/60"
                >
                  <Volume2 className="h-5 w-5 text-fuchsia-300 transition group-hover:scale-110" />
                  Tap for sound
                </button>
              </div>
            )}

            {playerProblem && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 text-center backdrop-blur-sm">
                <div className="max-w-sm rounded-3xl border border-amber-300/25 bg-black/70 p-6 shadow-[0_0_50px_rgba(251,191,36,0.18)]">
                  <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-300" />
                  <p className="font-display text-sm font-bold uppercase tracking-[0.2em] text-white">
                    YouTube blocked this player
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-300">{playerProblem}</p>
                  <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
                    <button
                      onClick={() => {
                        setPlayerProblem("");
                        appliedQidRef.current = null; // force a reload of this track
                        if (!playerRef.current) mountPlayer();
                        else sync();
                      }}
                      className="rounded-xl border border-white/10 bg-white/10 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white transition hover:bg-white/15"
                    >
                      Try again
                    </button>
                    <a
                      href={`https://www.youtube.com/watch?v=${np.videoId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/10 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white transition hover:bg-white/15"
                    >
                      YouTube <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* spinning vinyl chip */}
            <div className="absolute bottom-5 right-5 hidden sm:block">
              <div className={`vinyl relative h-24 w-24 rounded-full ${isPlaying ? "animate-spin-vinyl" : ""}`}>
                <div className="vinyl-sheen absolute inset-0 rounded-full" />
                <img
                  src={np.thumbnail}
                  alt=""
                  className="absolute inset-[26%] rounded-full object-cover"
                />
                <div className="absolute inset-[47%] rounded-full bg-[#0b0b13]" />
              </div>
            </div>

            {/* meta */}
            <div className="absolute bottom-0 left-0 right-0 p-6 pr-32 sm:p-7 sm:pr-36">
              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.3em] text-cyan-300/90">
                <UserRound className="h-3 w-3" />
                queued by {np.addedByName}
              </p>
              <h2 className="marquee-hover font-display text-xl font-bold leading-tight text-white [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden sm:text-2xl">
                {np.title}
              </h2>
              {np.artist && (
                <p className="mt-1.5 truncate font-serif text-lg italic text-zinc-300">
                  {np.artist}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* single timeline — draggable for the host, read-only for guests */}
      <div className="mx-auto mt-5 w-full max-w-[560px]">
        <div className="flex items-center justify-between text-[11px] font-semibold tabular-nums text-zinc-500">
          <span>{formatDuration(displayPos)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
        {isAdmin && duration > 0 ? (
          <input
            type="range"
            min={0}
            max={duration}
            step={1}
            value={Math.floor(displayPos)}
            onChange={(e) => seekLocal(Number(e.target.value))}
            onPointerUp={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
            onBlur={(e) => commitSeek(Number((e.target as HTMLInputElement).value))}
            className="vibe-range mt-2.5 block w-full"
            style={{ ["--fill" as string]: `${progress * 100}%` }}
            aria-label="Seek"
          />
        ) : (
          <div className="relative mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-400 via-fuchsia-400 to-cyan-300"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}
      </div>

      {/* controls */}
      <div className="mx-auto mt-5 flex w-full max-w-[560px] items-center justify-center gap-3">
        <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
          <button
            onClick={toggleMute}
            className="flex h-12 w-12 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/10 hover:text-white"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            className="vibe-range hidden w-24 sm:block"
            style={{ ["--fill" as string]: `${muted ? 0 : volume}%` }}
            aria-label="Volume"
          />
        </div>

        {isAdmin && (
          <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
            <button
              onClick={() => adminTransport(isPlaying ? "pause" : "resume")}
              className="flex h-12 w-16 items-center justify-center rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_24px_rgba(168,85,247,0.4)] transition hover:scale-105"
              title={isPlaying ? "Pause for everyone" : "Play for everyone"}
            >
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </button>
            <button
              onClick={() => adminTransport("skip")}
              className="flex h-12 w-12 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/10 hover:text-white"
              title="Skip track"
            >
              <SkipForward className="h-5 w-5" />
            </button>
          </div>
        )}

        {!ready && (
          <span className="text-xs text-zinc-500">warming up the deck…</span>
        )}
      </div>
    </div>
  );
}
