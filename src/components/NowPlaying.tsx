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
  Clock,
  RefreshCw,
} from "lucide-react";
import { createPlayer, YT_STATE, type YTPlayer } from "@/lib/yt-loader";
import {
  computeExpectedPosition,
  createClockSample,
  getWorldNowMs,
  selectBestClockAnchor,
  type ClockSample,
  type ClockSyncState,
} from "@/lib/clock";
import { formatDuration, type PartySnapshot } from "@/lib/types";

// Tight millisecond-level drift threshold (250ms) against the shared world clock.
const SEEK_TOLERANCE_SEC = 0.25;
// Minimum time between two corrective seeks (avoids decoder stutter loops).
const SEEK_COOLDOWN_MS = 1200;
// Small lead compensation (40ms) when issuing an active seek so decoder buffer
// resume lands right on the world-clock playhead.
const SEEK_LEAD_SEC = 0.04;

export default function NowPlaying({
  snap,
  isAdmin,
  onPlayerAction,
  onGoDiscover,
  onPositionChange,
}: {
  snap: PartySnapshot | null;
  isAdmin: boolean;
  onPlayerAction: (
    action: string,
    extra?: Record<string, unknown>
  ) => Promise<void>;
  onGoDiscover: () => void;
  onPositionChange?: (posSec: number) => void;
}) {
  const lifecycleRef = useRef(new AbortController());
  const mutedRef = useRef(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const readyRef = useRef(false);

  // Track both queueId and videoId so any song change is detected reliably.
  const appliedTrackKeyRef = useRef<string | null>(null);
  const appliedQidRef = useRef<number | null>(null);

  // Automatic self-healing retry state for song transitions (eliminates page refresh)
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const transitionWatchdogRef = useRef<number | null>(null);

  // High-precision monotonic world-clock sync state
  const clockSamplesRef = useRef<ClockSample[]>([]);
  const clockStateRef = useRef<ClockSyncState>({
    utcAtMonoZero:
      Date.now() - (typeof performance !== "undefined" ? performance.now() : 0),
    offsetMs: 0,
    bestRttMs: Infinity,
    sampleCount: 0,
    synced: false,
  });
  const [clockBadge, setClockBadge] = useState<{
    synced: boolean;
    rttMs: number;
    driftMs: number;
  }>({ synced: false, rttMs: 0, driftMs: 0 });

  const snapRef = useRef<PartySnapshot | null>(null);
  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [displayPos, setDisplayPos] = useState(0);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [playerProblem, setPlayerProblem] = useState("");
  // optimistic transport state (cleared as soon as the server confirms)
  const [uiPlaying, setUiPlaying] = useState<boolean | null>(null);
  // track key currently loaded into the player — drives the "switching" overlay
  const [loadedTrackKey, setLoadedTrackKey] = useState<string | null>(null);

  const busyRef = useRef(false);
  const lastServerUpdateRef = useRef(0);
  const scrubbingRef = useRef(false);
  const creatingRef = useRef(false);
  const pendingSeekRef = useRef(false);
  const lastSeekAtRef = useRef(0);
  const volumeRef = useRef(80);
  const onPlayerActionRef = useRef(onPlayerAction);
  const onPositionChangeRef = useRef(onPositionChange);

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
  }, [volume, muted]);

  useEffect(() => {
    onPlayerActionRef.current = onPlayerAction;
  }, [onPlayerAction]);

  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  }, [onPositionChange]);

  /* ---------- world-clock "now" in exact UTC milliseconds ---------- */
  const worldNowMs = useCallback(() => {
    return getWorldNowMs(
      clockStateRef.current,
      Date.now(),
      typeof performance !== "undefined" ? performance.now() : 0
    );
  }, []);

  /* ---------- compute expected position on the shared world timeline ---------- */
  const expectedPos = useCallback(() => {
    const s = snapRef.current;
    if (!s) return 0;
    return computeExpectedPosition(s.party, worldNowMs()).positionSec;
  }, [worldNowMs]);

  /* ---------- apply automatic unmute + volume to player ---------- */
  const ensureAudioActive = useCallback((p: YTPlayer | null) => {
    if (!p) return;
    try {
      if (mutedRef.current || volumeRef.current === 0) {
        p.mute();
      } else {
        p.unMute();
        p.setVolume(volumeRef.current || 80);
      }
    } catch {
      /* ignore if player bridge is still initializing */
    }
  }, []);

  /* ---------- Automatic global audio unlock (sound is ON by default) ---------- */
  useEffect(() => {
    const unlockAudio = () => {
      const p = playerRef.current;
      if (!p || !readyRef.current || mutedRef.current) return;
      try {
        p.unMute();
        p.setVolume(volumeRef.current || 80);
        if (
          snapRef.current?.party.isPlaying &&
          snapRef.current?.nowPlaying &&
          p.getPlayerState() !== YT_STATE.PLAYING
        ) {
          p.playVideo();
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointerdown", unlockAudio, { passive: true });
    window.addEventListener("keydown", unlockAudio, { passive: true });
    window.addEventListener("touchstart", unlockAudio, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
    };
  }, []);

  /* ---------- Multi-sample NTP burst clock sync against UTC world clock ---------- */
  const runClockBurst = useCallback(async (burstCount = 4) => {
    for (let i = 0; i < burstCount; i++) {
      try {
        const t0 = performance.now();
        const res = await fetch("/api/time", { cache: "no-store" });
        const t1 = performance.now();
        if (!res.ok) continue;
        const data = (await res.json()) as { utcMs?: number; t?: number };
        const serverUtcMs = Number(data.utcMs ?? data.t);
        if (!Number.isFinite(serverUtcMs)) continue;

        const sample = createClockSample(t0, t1, serverUtcMs);
        clockSamplesRef.current = [
          ...clockSamplesRef.current.slice(-11),
          sample,
        ];
        const nextState = selectBestClockAnchor(
          clockSamplesRef.current,
          Date.now(),
          performance.now()
        );
        clockStateRef.current = nextState;
        setClockBadge((prev) => ({
          ...prev,
          synced: nextState.synced,
          rttMs: Math.round(nextState.bestRttMs),
        }));
      } catch {
        /* keep previous anchor */
      }
      if (i < burstCount - 1) {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await runClockBurst(4);
    })();
    const iv = window.setInterval(() => {
      if (!cancelled) runClockBurst(2);
    }, 15000);
    const onVis = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        runClockBurst(3);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [runClockBurst]);

  // Fallback until the first NTP burst sample lands: use snapshot serverNow.
  useEffect(() => {
    if (!snap || clockStateRef.current.synced) return;
    const monoNow = typeof performance !== "undefined" ? performance.now() : 0;
    clockStateRef.current = {
      utcAtMonoZero: snap.serverNow - monoNow,
      offsetMs: snap.serverNow - Date.now(),
      bestRttMs: Infinity,
      sampleCount: 1,
      synced: true,
    };
  }, [snap]);

  // Forward declarations via refs so rebuildPlayer, mountPlayer, and sync can call each other cleanly
  const syncRef = useRef<(forceSeek?: boolean) => void>(() => {});
  const rebuildPlayerRef = useRef<() => void>(() => {});

  /* ---------- clear transition timers ---------- */
  const clearTransitionTimers = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (transitionWatchdogRef.current !== null) {
      window.clearTimeout(transitionWatchdogRef.current);
      transitionWatchdogRef.current = null;
    }
  }, []);

  /* ---------- player event handlers ---------- */
  const handleStateChange = useCallback(
    (state: number, target?: YTPlayer) => {
      if (target && target !== playerRef.current) return;
      if (state === YT_STATE.ENDED) {
        const s = snapRef.current;
        const qid = appliedQidRef.current ?? s?.nowPlaying?.queueId ?? null;
        if (s?.nowPlaying && qid) {
          onPlayerActionRef
            .current("ended", { queueId: qid })
            .catch(() => undefined);
        }
        return;
      }

      if (state === YT_STATE.PLAYING || state === YT_STATE.PAUSED) {
        // Track transition succeeded! Reset retry counters and clear any transient error.
        retryCountRef.current = 0;
        setPlayerProblem("");
        if (transitionWatchdogRef.current !== null) {
          window.clearTimeout(transitionWatchdogRef.current);
          transitionWatchdogRef.current = null;
        }
        const s = snapRef.current;
        if (s?.nowPlaying) {
          setLoadedTrackKey(`${s.nowPlaying.queueId ?? 0}:${s.nowPlaying.videoId}`);
        }
        ensureAudioActive(playerRef.current);

        if (pendingSeekRef.current) {
          pendingSeekRef.current = false;
          const p = playerRef.current;
          if (p && s?.nowPlaying) {
            try {
              const targetSec =
                expectedPos() + (s.party.isPlaying ? SEEK_LEAD_SEC : 0);
              p.seekTo(targetSec, true);
              lastSeekAtRef.current = Date.now();
            } catch {
              /* ignore */
            }
          }
        }
      }
    },
    [expectedPos, ensureAudioActive]
  );

  const handleError = useCallback(
    (code: number, target?: YTPlayer) => {
      if (target && target !== playerRef.current) return;
      const np = snapRef.current?.nowPlaying;
      if (!np?.videoId) return;

      // Self-healing recovery: before showing any error to the user, automatically
      // retry loading or recreate the YouTube player instance (just like a page refresh).
      if (retryCountRef.current < 2) {
        retryCountRef.current += 1;
        const attempt = retryCountRef.current;
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current);
        }
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (attempt === 1 && playerRef.current && readyRef.current) {
            // Attempt 1: re-issue loadVideoById on the existing player
            appliedTrackKeyRef.current = null;
            syncRef.current(true);
          } else {
            // Attempt 2: full in-place player rebuild (equivalent to a page refresh)
            rebuildPlayerRef.current();
          }
        }, 350);
        return;
      }

      const friendly =
        code === 101 || code === 150
          ? "This YouTube video does not allow embedded playback. Skip it or choose another version."
          : "YouTube had trouble loading this track. Click Retry or skip to the next track.";
      setPlayerProblem(friendly);
    },
    []
  );

  /* ---------- create or recreate the player in place ---------- */
  const mountPlayer = useCallback(() => {
    const el = mountRef.current;
    if (!el || playerRef.current || creatingRef.current) return;
    creatingRef.current = true;
    const signal = lifecycleRef.current.signal;
    createPlayer(
      el,
      {
        onReady: (p) => {
          playerRef.current = p;
          readyRef.current = true;
          setPlayerProblem("");
          ensureAudioActive(p);
          setReady(true);
          syncRef.current(true);
        },
        onStateChange: handleStateChange,
        onError: handleError,
      },
      signal
    )
      .catch((err) => {
        if (signal.aborted) return;
        playerRef.current = null;
        readyRef.current = false;
        setPlayerProblem(
          err instanceof Error
            ? err.message
            : "YouTube player could not start."
        );
      })
      .finally(() => {
        if (!signal.aborted) creatingRef.current = false;
      });
  }, [handleStateChange, handleError, ensureAudioActive]);

  const rebuildPlayer = useCallback(() => {
    clearTransitionTimers();
    try {
      playerRef.current?.destroy();
    } catch {
      /* ignore */
    }
    playerRef.current = null;
    readyRef.current = false;
    creatingRef.current = false;
    appliedTrackKeyRef.current = null;
    appliedQidRef.current = null;
    setReady(false);
    setPlayerProblem("");
    mountPlayer();
  }, [clearTransitionTimers, mountPlayer]);

  useEffect(() => {
    rebuildPlayerRef.current = rebuildPlayer;
  }, [rebuildPlayer]);

  /* ---------- sync the player with the shared world clock ---------- */
  const sync = useCallback(
    (forceSeek = false) => {
      const s = snapRef.current;
      if (!s) return;

      const np = s.nowPlaying;
      const p = s.party;

      // If we have a track but the player isn't mounted or its iframe got detached, heal it
      const player = playerRef.current;
      if (np?.videoId) {
        if (!player || !readyRef.current) {
          mountPlayer();
          return;
        }
        try {
          const iframe = player.getIframe?.();
          if (iframe && !iframe.isConnected) {
            rebuildPlayer();
            return;
          }
        } catch {
          rebuildPlayer();
          return;
        }
      }

      if (!player || !readyRef.current) return;
      const expected = expectedPos();

      try {
        if (np && np.videoId) {
          const trackKey = `${np.queueId ?? 0}:${np.videoId}`;
          if (appliedTrackKeyRef.current !== trackKey) {
            appliedTrackKeyRef.current = trackKey;
            appliedQidRef.current = np.queueId;
            setLoadedTrackKey(trackKey);
            setPlayerProblem("");
            pendingSeekRef.current = true;

            ensureAudioActive(player);
            const startSeconds = Math.max(
              0,
              expected + (p.isPlaying ? SEEK_LEAD_SEC : 0)
            );

            if (p.isPlaying) {
              player.loadVideoById({
                videoId: np.videoId,
                startSeconds,
              });
            } else {
              player.cueVideoById({
                videoId: np.videoId,
                startSeconds: expected,
              });
            }

            // Watchdog: if the new song is supposed to be playing but gets stuck
            // in UNSTARTED (-1) or CUED (5) for >3.8s during transition, self-heal automatically.
            if (transitionWatchdogRef.current !== null) {
              window.clearTimeout(transitionWatchdogRef.current);
            }
            transitionWatchdogRef.current = window.setTimeout(() => {
              transitionWatchdogRef.current = null;
              const curSnap = snapRef.current;
              const curPlayer = playerRef.current;
              if (!curSnap?.nowPlaying || !curSnap.party.isPlaying || !curPlayer) {
                return;
              }
              try {
                const st = curPlayer.getPlayerState();
                if (st !== YT_STATE.PLAYING && st !== YT_STATE.BUFFERING) {
                  if (retryCountRef.current < 1) {
                    retryCountRef.current += 1;
                    ensureAudioActive(curPlayer);
                    curPlayer.loadVideoById({
                      videoId: curSnap.nowPlaying.videoId,
                      startSeconds: expectedPos() + SEEK_LEAD_SEC,
                    });
                    curPlayer.playVideo();
                  } else {
                    rebuildPlayer();
                  }
                }
              } catch {
                rebuildPlayer();
              }
            }, 3800);
            return;
          }

          const st = player.getPlayerState();

          // Keep audio unmuted automatically unless the user explicitly clicked mute
          ensureAudioActive(player);

          if (p.isPlaying) {
            if (st !== YT_STATE.PLAYING && st !== YT_STATE.BUFFERING) {
              player.playVideo();
            }
          } else {
            if (st === YT_STATE.PLAYING || st === YT_STATE.BUFFERING) {
              player.pauseVideo();
            }
          }

          // Millisecond drift tracking & corrective seek when settled
          if (st === YT_STATE.PLAYING || st === YT_STATE.PAUSED) {
            const cur = player.getCurrentTime();
            if (Number.isFinite(cur)) {
              const driftSec = cur - expected;
              const driftMs = Math.round(driftSec * 1000);
              setClockBadge((prev) =>
                prev.driftMs === driftMs ? prev : { ...prev, driftMs }
              );

              if (
                forceSeek ||
                (Math.abs(driftSec) > SEEK_TOLERANCE_SEC &&
                  Date.now() - lastSeekAtRef.current > SEEK_COOLDOWN_MS)
              ) {
                const targetSec =
                  expected + (p.isPlaying ? SEEK_LEAD_SEC : 0);
                player.seekTo(targetSec, true);
                lastSeekAtRef.current = Date.now();
              }
            }
          }
        } else if (appliedTrackKeyRef.current !== null) {
          appliedTrackKeyRef.current = null;
          appliedQidRef.current = null;
          setLoadedTrackKey(null);
          setPlayerProblem("");
          clearTransitionTimers();
          try {
            player.stopVideo();
          } catch {
            /* ignore */
          }
        }
      } catch {
        // If calling methods on the player threw an exception, rebuild it automatically
        if (retryCountRef.current < 2) {
          retryCountRef.current += 1;
          rebuildPlayer();
        }
      }
    },
    [
      expectedPos,
      mountPlayer,
      rebuildPlayer,
      ensureAudioActive,
      clearTransitionTimers,
    ]
  );

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  // Mount the player once on component mount and keep it alive across tracks
  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    mountPlayer();
    return () => {
      controller.abort();
      clearTransitionTimers();
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      readyRef.current = false;
      creatingRef.current = false;
      appliedTrackKeyRef.current = null;
      appliedQidRef.current = null;
    };
  }, [mountPlayer, clearTransitionTimers]);

  // Whenever the active track changes, reset error/retry counters and sync immediately
  useEffect(() => {
    retryCountRef.current = 0;
    setPlayerProblem("");
    sync(false);
  }, [snap?.nowPlaying?.queueId, snap?.nowPlaying?.videoId, sync]);

  // Keep the player tightly synced with the world clock (every 500ms)
  useEffect(() => {
    const t = setInterval(() => sync(false), 500);
    return () => clearInterval(t);
  }, [sync]);

  useEffect(() => {
    sync(false);
  }, [snap, sync]);

  // When a fresh server state arrives, stop overriding with optimistic UI.
  useEffect(() => {
    if (!snap) return;
    if (lastServerUpdateRef.current !== snap.party.updatedAtMs) {
      lastServerUpdateRef.current = snap.party.updatedAtMs;
      setUiPlaying(null);
    }
  }, [snap]);

  /* ---------- high-resolution 100ms local progress anchored to world clock ---------- */
  useEffect(() => {
    const t = setInterval(() => {
      const s = snapRef.current;
      if (!s || !s.nowPlaying) {
        setDisplayPos(0);
        onPositionChangeRef.current?.(0);
        return;
      }
      if (scrubbingRef.current) return;
      const { positionSec } = computeExpectedPosition(s.party, worldNowMs());
      setDisplayPos(positionSec);
      onPositionChangeRef.current?.(positionSec);
    }, 100);
    return () => clearInterval(t);
  }, [worldNowMs]);

  const toggleMute = () => {
    const p = playerRef.current;
    if (muted) {
      mutedRef.current = false;
      setMuted(false);
      if (p) {
        try {
          p.unMute();
          p.setVolume(volumeRef.current || 80);
          if (snapRef.current?.party.isPlaying) p.playVideo();
        } catch {
          /* ignore */
        }
      }
    } else {
      mutedRef.current = true;
      setMuted(true);
      if (p) {
        try {
          p.mute();
        } catch {
          /* ignore */
        }
      }
    }
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    volumeRef.current = v;
    const p = playerRef.current;
    if (!p) return;
    try {
      p.setVolume(v);
      if (v === 0) {
        mutedRef.current = true;
        setMuted(true);
        p.mute();
      } else {
        mutedRef.current = false;
        setMuted(false);
        p.unMute();
        if (snapRef.current?.party.isPlaying) p.playVideo();
      }
    } catch {
      /* ignore */
    }
  };

  const adminTransport = async (action: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (action === "pause") {
        setUiPlaying(false);
        try {
          playerRef.current?.pauseVideo();
        } catch {
          /* ignore */
        }
      } else if (action === "resume") {
        setUiPlaying(true);
        const p = playerRef.current;
        if (p) {
          try {
            ensureAudioActive(p);
            p.seekTo(displayPos + SEEK_LEAD_SEC, true);
            p.playVideo();
          } catch {
            /* ignore */
          }
        }
      } else if (action === "skip") {
        setPlayerProblem("");
        retryCountRef.current = 0;
      }
    } catch {
      /* ignore */
    }

    try {
      if (action === "pause")
        await onPlayerAction("pause", { positionSec: displayPos });
      else if (action === "resume")
        await onPlayerAction("resume", { positionSec: displayPos });
      else await onPlayerAction(action);
    } catch {
      setUiPlaying(null);
    } finally {
      busyRef.current = false;
    }
  };

  const seekLocal = (sec: number) => {
    scrubbingRef.current = true;
    setDisplayPos(sec);
    onPositionChangeRef.current?.(sec);
    try {
      playerRef.current?.seekTo(sec, true);
    } catch {
      /* ignore */
    }
  };

  const commitSeek = (sec: number) => {
    scrubbingRef.current = false;
    onPlayerAction("seek", { positionSec: sec }).catch(() => undefined);
  };

  const resyncExactMs = async () => {
    await runClockBurst(3);
    sync(true);
  };

  const np = snap?.nowPlaying ?? null;
  const duration = snap?.party.durationSec ?? 0;
  const isPlaying = uiPlaying ?? (!!snap?.party.isPlaying && !!np);
  const progress = duration > 0 ? Math.min(1, displayPos / duration) : 0;
  const currentTrackKey = np ? `${np.queueId ?? 0}:${np.videoId}` : null;
  const switching = !!np && loadedTrackKey !== currentTrackKey;

  const handleTilt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 10;
    const y = ((e.clientY - r.top) / r.height - 0.5) * -10;
    setTilt({ x: y, y: x });
  };

  return (
    <div className="flex flex-col items-center justify-center animate-fade-up">
      {/* Poster / Empty Deck */}
      <div
        className="relative mx-auto w-full max-w-[min(100%,440px)] lg:max-w-[min(100%,46dvh)]"
        style={{ perspective: "1200px" }}
        onMouseMove={np ? handleTilt : undefined}
        onMouseLeave={np ? () => setTilt({ x: 0, y: 0 }) : undefined}
      >
        {/* ambient glow from artwork */}
        {np && (
          <div
            className="absolute -inset-8 -z-10 rounded-[3rem] opacity-50 blur-3xl saturate-150"
            style={{
              backgroundImage: `url(${np.thumbnail})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          />
        )}

        <div
          className="poster-ring rounded-[2.2rem] p-[3px] transition-transform duration-200 ease-out"
          style={{
            ["--p" as string]: np ? progress : 0,
            transform: np ? `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` : undefined,
          }}
        >
          <div className="relative aspect-square w-full overflow-hidden rounded-[2.05rem] bg-black shadow-[0_40px_110px_rgba(0,0,0,0.8)]">
            {/* Persistent YouTube player container — stays mounted so iframe never reloads */}
            <div
              className={`absolute inset-0 [&>div]:h-full [&>div]:w-full ${
                np ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
            >
              <div ref={mountRef} className="h-full w-full" />
            </div>

            {!np ? (
              /* Empty deck state */
              <div className="glass-deep relative flex h-full w-full flex-col items-center justify-center overflow-hidden p-6 text-center">
                <div className="vinyl animate-spin-slow absolute h-[120%] w-[120%] rounded-full opacity-20" />
                <div className="relative z-10">
                  <div className="mx-auto mb-4 flex h-16 w-16 animate-float-y items-center justify-center rounded-3xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20">
                    <Disc3
                      className="h-8 w-8 animate-spin-slow text-violet-300"
                      strokeWidth={1.4}
                    />
                  </div>
                  <h2 className="font-display text-xl font-bold text-white sm:text-2xl">
                    The deck is waiting
                  </h2>
                  <p className="mx-auto mt-2 max-w-xs font-serif text-base italic text-zinc-400">
                    be the one who drops the first track
                  </p>
                  <button
                    onClick={onGoDiscover}
                    className="group mt-6 inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400 px-5 py-3 font-display text-xs font-bold uppercase tracking-[0.22em] text-white transition hover:shadow-[0_0_40px_rgba(217,70,239,0.4)]"
                  >
                    <Sparkles className="h-4 w-4" />
                    Find a song
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* cinematic overlays */}
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/45" />
                <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background:repeating-linear-gradient(0deg,transparent_0_2px,#fff_2px_3px)]" />

                {/* top strip */}
                <div className="absolute left-0 right-0 top-0 flex items-start justify-between p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isPlaying ? (
                      <span className="animate-pulse-ring flex items-center gap-1.5 rounded-full border border-red-400/40 bg-black/60 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-red-300 backdrop-blur-md">
                        <Signal className="h-3 w-3" /> live
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-300 backdrop-blur-md">
                        <Pause className="h-3 w-3" /> paused
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={resyncExactMs}
                      title="Click to force exact millisecond world-clock resync"
                      className="flex items-center gap-1 rounded-full border border-cyan-400/30 bg-black/60 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-cyan-200 backdrop-blur-md transition hover:border-cyan-300/60 hover:bg-black/80"
                    >
                      <Clock className="h-2.5 w-2.5 text-cyan-300" />
                      <span>
                        UTC{" "}
                        {clockBadge.synced
                          ? `±${Math.abs(clockBadge.driftMs)}ms`
                          : "syncing"}
                      </span>
                    </button>
                  </div>

                  {/* equalizer */}
                  <div
                    className={`flex h-5 items-end gap-[2.5px] ${
                      isPlaying ? "" : "eq-paused"
                    }`}
                  >
                    {[0.9, 0.5, 1.1, 0.7, 1.3, 0.6, 1].map((d, i) => (
                      <span
                        key={i}
                        className="eq-bar w-[2.5px] rounded-full bg-gradient-to-t from-fuchsia-400 to-cyan-300"
                        style={{ height: "100%", animationDuration: `${d}s` }}
                      />
                    ))}
                  </div>
                </div>

                {/* track switching / loading overlay */}
                {switching && !playerProblem && (
                  <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/45">
                    <div className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-black/65 px-4 py-3 backdrop-blur-md">
                      <LoaderCircle className="h-4 w-4 animate-spin text-fuchsia-300" />
                      <span className="font-display text-[11px] font-bold uppercase tracking-[0.22em] text-white">
                        loading track…
                      </span>
                    </div>
                  </div>
                )}

                {playerProblem && (
                  <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 p-5 text-center backdrop-blur-sm">
                    <div className="max-w-xs rounded-3xl border border-amber-300/25 bg-black/80 p-5 shadow-[0_0_50px_rgba(251,191,36,0.18)]">
                      <AlertTriangle className="mx-auto mb-2.5 h-7 w-7 text-amber-300" />
                      <p className="font-display text-xs font-bold uppercase tracking-[0.18em] text-white">
                        Playback recovery
                      </p>
                      <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                        {playerProblem}
                      </p>
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        <button
                          onClick={() => {
                            retryCountRef.current = 0;
                            rebuildPlayer();
                          }}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/10 px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider text-white transition hover:bg-white/20"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Retry
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => adminTransport("skip")}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3.5 py-2 text-[11px] font-bold uppercase tracking-wider text-white"
                          >
                            <SkipForward className="h-3.5 w-3.5" />
                            Skip
                          </button>
                        )}
                        <a
                          href={`https://www.youtube.com/watch?v=${np.videoId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center justify-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-zinc-300 transition hover:bg-white/15"
                        >
                          YouTube <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* spinning vinyl chip */}
                <div className="absolute bottom-4 right-4 hidden sm:block">
                  <div
                    className={`vinyl relative h-20 w-20 rounded-full ${
                      isPlaying ? "animate-spin-vinyl" : ""
                    }`}
                  >
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
                <div className="absolute bottom-0 left-0 right-0 p-5 pr-28 sm:p-6 sm:pr-32">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.28em] text-cyan-300/90">
                    <UserRound className="h-3 w-3" />
                    queued by {np.addedByName}
                  </p>
                  <h2 className="marquee-hover font-display text-lg font-bold leading-tight text-white [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden sm:text-xl">
                    {np.title}
                  </h2>
                  {np.artist && (
                    <p className="mt-1 truncate font-serif text-base italic text-zinc-300">
                      {np.artist}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Timeline & Controls when a track is active */}
      {np && (
        <>
          <div className="mx-auto mt-3.5 w-full max-w-[min(100%,440px)] lg:max-w-[min(100%,46dvh)]">
            <div className="flex items-center justify-between text-[11px] font-semibold tabular-nums text-zinc-500">
              <span>{formatDuration(displayPos)}</span>
              <span className="text-[10px] text-zinc-600">
                {Math.floor((displayPos % 1) * 1000)
                  .toString()
                  .padStart(3, "0")}
                ms
              </span>
              <span>{formatDuration(duration)}</span>
            </div>
            {isAdmin && duration > 0 ? (
              <input
                type="range"
                min={0}
                max={duration}
                step={0.05}
                value={Math.min(duration, displayPos)}
                onChange={(e) => seekLocal(Number(e.target.value))}
                onPointerUp={(e) =>
                  commitSeek(Number((e.target as HTMLInputElement).value))
                }
                onBlur={(e) =>
                  commitSeek(Number((e.target as HTMLInputElement).value))
                }
                className="vibe-range mt-2 block w-full"
                style={{ ["--fill" as string]: `${progress * 100}%` }}
                aria-label="Seek"
              />
            ) : (
              <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-400 via-fuchsia-400 to-cyan-300"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
          </div>

          <div className="mx-auto mt-3.5 flex w-full max-w-[min(100%,440px)] flex-wrap items-center justify-center gap-2.5 lg:max-w-[min(100%,46dvh)]">
            <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
              <button
                onClick={toggleMute}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/10 hover:text-white"
                title={muted ? "Unmute" : "Mute"}
              >
                {muted ? (
                  <VolumeX className="h-4.5 w-4.5" />
                ) : (
                  <Volume2 className="h-4.5 w-4.5" />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={muted ? 0 : volume}
                onChange={(e) => changeVolume(Number(e.target.value))}
                className="vibe-range mr-2 w-20 sm:w-24"
                style={{ ["--fill" as string]: `${muted ? 0 : volume}%` }}
                aria-label="Volume"
              />
            </div>

            {isAdmin && (
              <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
                <button
                  onClick={() => adminTransport(isPlaying ? "pause" : "resume")}
                  className="flex h-10 w-14 items-center justify-center rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_24px_rgba(168,85,247,0.4)] transition hover:scale-105"
                  title={isPlaying ? "Pause for everyone" : "Play for everyone"}
                >
                  {isPlaying ? (
                    <Pause className="h-4.5 w-4.5" />
                  ) : (
                    <Play className="ml-0.5 h-4.5 w-4.5" />
                  )}
                </button>
                <button
                  onClick={() => adminTransport("skip")}
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/10 hover:text-white"
                  title="Skip track"
                >
                  <SkipForward className="h-4.5 w-4.5" />
                </button>
              </div>
            )}

            {!ready && (
              <span className="text-xs text-zinc-500">
                warming up the deck…
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
