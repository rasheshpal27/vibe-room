"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  Shuffle,
} from "lucide-react";
import {
  applyDataSaverQuality,
  createPlayer,
  disableCaptions,
  YT_STATE,
  type YTPlayer,
} from "@/lib/yt-loader";
import { computeExpectedPosition, getWorldNowMs } from "@/lib/clock";
import {
  classifyPlayerError,
  crossfadeGains,
  effectiveDriftDeadband,
  effectiveRemainingSec,
  planRecovery,
  seekCooldownMs,
  shouldArmEarlyEnd,
  shouldHealStall,
  shouldRetryLoad,
  planDriftCorrection,
  CROSSFADE_SEC,
  FADE_HOLD_MAX_MS,
  LOAD_GRACE_MS,
  LOAD_GRACE_SLOW_MS,
  POST_BUFFER_GRACE_MS,
  POST_BUFFER_SLOW_GRACE_MS,
  PRELOAD_LEAD_SEC,
  SKIP_FADE_MS,
  STALL_GRACE_MS,
  STALL_GRACE_SLOW_MS,
  RATE_NORMAL,
  type PlayerErrorKind,
} from "@/lib/playback";
import {
  getNetworkProfile,
  recordBufferingStall,
  recordNetworkSample,
  subscribeNetworkProfile,
} from "@/lib/network-profile";
import {
  installAudioUnlockListeners,
  isAudioUnlocked,
  markAudioUnlocked,
  onAudioUnlock,
} from "@/lib/audio-unlock";
import { setPlayhead } from "@/lib/playhead";
import {
  addClockSample,
  getClockState,
  seedClockFromServerNow,
  subscribeClock,
} from "@/lib/clock-store";
import { onRoomEvent } from "@/lib/room-events";
import {
  clearMediaSession,
  setMediaSessionHandlers,
  setMediaSessionPlaybackState,
  setMediaSessionPosition,
  setMediaSessionTrack,
} from "@/lib/media-session";
import { formatDuration, type PartySnapshot } from "@/lib/types";

// Three consecutive readings outside the active deadband must breach before
// seeking (prevents measurement noise and brief buffering from triggering seeks).
const SEEK_STRIKES_BEFORE_SEEK = 3;
// Minimum base cooldown between corrective seeks (escalates per seek via seekCooldownMs).
const SEEK_COOLDOWN_MS = 8000;
// Minimum time between two play() nudges when the player drifts out of state.
const PLAY_NUDGE_COOLDOWN_MS = 1200;
// How long audible autoplay may fail before we fall back to muted playback.
const AUTOPLAY_BLOCK_MS = 1800;
const AUTOPLAY_BLOCK_SLOW_MS = 3200;
// Constrain iframe viewport in Data Saver mode so YouTube ABR stays in low quality.
const DATA_SAVER_IFRAME_PX = 220;
// Small lead compensation (40ms) when issuing an active seek so decoder buffer
// resume lands right on the world-clock playhead.
const SEEK_LEAD_SEC = 0.04;
// Volume ramp resolution during a crossfade.
const FADE_STEP_MS = 60;
const CROSSFADE_MS = CROSSFADE_SEC * 1000;

export default function NowPlaying({
  snap,
  isAdmin,
  onPlayerAction,
  onGoDiscover,
}: {
  snap: PartySnapshot | null;
  isAdmin: boolean;
  onPlayerAction: (
    action: string,
    extra?: Record<string, unknown>
  ) => Promise<void>;
  onGoDiscover: () => void;
}) {
  const lifecycleRef = useRef(new AbortController());
  const idleLifecycleRef = useRef(new AbortController());
  /* Two decks. `playerRef` is always the one that owns the room's current
     track; `idlePlayerRef` is the other one — it preloads the next song and
     then plays the outgoing song's tail while the two crossfade. They swap
     roles on every natural song change. */
  const hostARef = useRef<HTMLDivElement | null>(null);
  const hostBRef = useRef<HTMLDivElement | null>(null);
  const activeDeckRef = useRef<"A" | "B">("A");
  const playerRef = useRef<YTPlayer | null>(null);
  const idlePlayerRef = useRef<YTPlayer | null>(null);
  const idleReadyRef = useRef(false);
  const idleCreatingRef = useRef(false);
  /** videoId armed on the idle deck, and how far that preload has got. */
  const preloadedVideoRef = useRef<string | null>(null);
  const preloadStateRef = useRef<"idle" | "loading" | "ready">("idle");
  /** Track key whose ending we reported early to open the crossfade. */
  const armedEndTrackRef = useRef<string | null>(null);
  /** Track key that has hit YouTube's ENDED — never nudge it back to life. */
  const endedHoldRef = useRef<string | null>(null);
  const fadeRef = useRef<{
    incoming: YTPlayer | null;
    outgoing: YTPlayer | null;
    /** 0 while we wait for the incoming deck to actually produce sound. */
    startedAt: number;
    createdAt: number;
    ms: number;
  } | null>(null);
  const lastPreloadAtRef = useRef(0);
  const lastIdleMountAtRef = useRef(0);
  const fadeTimerRef = useRef<number | null>(null);
  const readyRef = useRef(false);

  /* ---------- track identity ---------- */
  const appliedTrackKeyRef = useRef<string | null>(null);
  const appliedQidRef = useRef<number | null>(null);
  const wantedVideoIdRef = useRef<string | null>(null);
  const loadStartedAtRef = useRef(0);
  const loadConfirmedRef = useRef(false);
  const endedReportedRef = useRef<Set<string>>(new Set());
  const unplayableReportedRef = useRef<Set<string>>(new Set());

  /* ---------- self-healing state ---------- */
  const recoveryAttemptRef = useRef(0);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryKindRef = useRef<PlayerErrorKind>("transient");
  // 0 until the first sync tick stamps it (keeps render pure).
  const lastHealthyAtRef = useRef(0);
  const forceMutedRef = useRef(false);
  // At most one automatic unmute attempt per track after a muted fallback.
  const autoUnmuteTriedRef = useRef(false);
  /** True once this page has actually produced audible playback. */
  const audiblePlaybackRef = useRef(false);

  /* ---------- audio ---------- */
  const mutedRef = useRef(false);
  const volumeRef = useRef(80);
  const soundAllowedRef = useRef(false);

  /* ---------- network & data-saver profile ---------- */
  const networkProfile = useSyncExternalStore(
    subscribeNetworkProfile,
    getNetworkProfile,
    getNetworkProfile
  );
  const networkProfileRef = useRef(networkProfile);
  useEffect(() => {
    networkProfileRef.current = networkProfile;
    applyDataSaverQuality(playerRef.current, networkProfile.dataSaver);
    if (
      (networkProfile.dataSaver || networkProfile.slowNetwork) &&
      !fadeRef.current &&
      preloadedVideoRef.current
    ) {
      try {
        idlePlayerRef.current?.stopVideo();
      } catch {
        /* bridge busy */
      }
      preloadedVideoRef.current = null;
      preloadStateRef.current = "idle";
    }
  }, [networkProfile]);

  const posterBoxRef = useRef<HTMLDivElement | null>(null);
  const [posterPx, setPosterPx] = useState(0);
  useEffect(() => {
    const el = posterBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const w = Math.round(el.clientWidth);
      setPosterPx((prev) => (prev === w ? prev : w));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- world clock ----------
     Shared with the room poller: every /api/state response carries the
     server clock in a header, so those count as samples too and the anchor
     stays fresh between bursts. */
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
  const [healing, setHealing] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [activeDeck, setActiveDeck] = useState<"A" | "B">("A");
  const [fadeMs, setFadeMs] = useState(CROSSFADE_MS);
  const [crossfading, setCrossfading] = useState(false);
  // optimistic transport state (cleared as soon as the server confirms)
  const [uiPlaying, setUiPlaying] = useState<boolean | null>(null);
  // track key currently confirmed playing — drives the "switching" overlay
  const [loadedTrackKey, setLoadedTrackKey] = useState<string | null>(null);

  const busyRef = useRef(false);
  const lastServerUpdateRef = useRef(0);
  const scrubbingRef = useRef(false);
  const creatingRef = useRef(false);
  const pendingSeekRef = useRef(false);
  const lastSeekAtRef = useRef(0);
  const seeksInTrackRef = useRef(0);
  const lastSeenPartyUpdatedAtRef = useRef(0);
  const bufferingStartedAtRef = useRef(0);
  const bufferingReportedForEpisodeRef = useRef(false);
  const lastBufferedAtRef = useRef(0);
  const driftStrikesRef = useRef(0);
  /* ---------- drift steering (soft correction) ---------- */
  /** Rate currently applied to the live deck. */
  const playbackRateRef = useRef(RATE_NORMAL);
  /** Cleared the first time the player refuses a fractional rate. */
  const rateSupportedRef = useRef(true);
  /** A rate we asked for but have not yet confirmed the player accepted. */
  const pendingRateRef = useRef<{ rate: number; atMs: number } | null>(null);
  const lastNudgeAtRef = useRef(0);
  const reportedDurationRef = useRef<string | null>(null);
  const onPlayerActionRef = useRef(onPlayerAction);

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
  }, [volume, muted]);

  useEffect(() => {
    onPlayerActionRef.current = onPlayerAction;
  }, [onPlayerAction]);

  /* ---------- mirrored state (readable from timers without re-renders) ---------- */
  const playerProblemRef = useRef("");
  const loadedTrackKeyRef = useRef<string | null>(null);

  const setProblem = useCallback((message: string) => {
    if (playerProblemRef.current === message) return;
    playerProblemRef.current = message;
    setPlayerProblem(message);
  }, []);

  /** Guarded like setProblem: never re-render for a value that is unchanged. */
  const healingRef = useRef(false);
  const setHealingState = useCallback((next: boolean) => {
    if (healingRef.current === next) return;
    healingRef.current = next;
    setHealing(next);
  }, []);

  const setLoadedKey = useCallback((key: string | null) => {
    if (loadedTrackKeyRef.current === key) return;
    loadedTrackKeyRef.current = key;
    setLoadedTrackKey(key);
  }, []);

  /**
   * Set the deck's playback rate.
   *
   * YouTube documents `setPlaybackRate` as honouring only the values in
   * `getAvailablePlaybackRates()`, and the IFrame bridge is asynchronous, so
   * the acceptance check happens on a later tick (see `verifyPlaybackRate`)
   * rather than immediately — reading the rate back in the same turn races
   * the postMessage round trip and would disable steering on every browser.
   */
  const applyPlaybackRate = useCallback((p: YTPlayer | null, rate: number) => {
    if (!p) return;
    if (!p.setPlaybackRate) {
      rateSupportedRef.current = false;
      return;
    }
    if (Math.abs(playbackRateRef.current - rate) < 0.001) return;
    try {
      p.setPlaybackRate(rate);
      playbackRateRef.current = rate;
      pendingRateRef.current =
        rate === RATE_NORMAL ? null : { rate, atMs: Date.now() };
    } catch {
      rateSupportedRef.current = false;
      playbackRateRef.current = RATE_NORMAL;
      pendingRateRef.current = null;
    }
  }, []);

  /** Did the player actually take the rate we asked for? */
  const verifyPlaybackRate = useCallback((p: YTPlayer | null) => {
    const pending = pendingRateRef.current;
    if (!pending || !p?.getPlaybackRate) return;
    if (Date.now() - pending.atMs < 900) return;
    pendingRateRef.current = null;
    try {
      const actual = p.getPlaybackRate();
      if (Number.isFinite(actual) && Math.abs(actual - pending.rate) > 0.005) {
        // This build only accepts its menu rates — go back to seek-only.
        rateSupportedRef.current = false;
        playbackRateRef.current = RATE_NORMAL;
        p.setPlaybackRate?.(RATE_NORMAL);
      }
    } catch {
      rateSupportedRef.current = false;
    }
  }, []);

  /** A new track always starts at normal speed. */
  const resetPlaybackRate = useCallback((p: YTPlayer | null) => {
    pendingRateRef.current = null;
    if (playbackRateRef.current === RATE_NORMAL) return;
    playbackRateRef.current = RATE_NORMAL;
    try {
      p?.setPlaybackRate?.(RATE_NORMAL);
    } catch {
      /* ignore */
    }
  }, []);

  /* ---------- world-clock "now" in exact UTC milliseconds ---------- */
  const worldNowMs = useCallback(() => {
    return getWorldNowMs(
      getClockState(),
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

  /* ---------- deck plumbing ---------- */
  const hostFor = useCallback(
    (deck: "A" | "B") => (deck === "A" ? hostARef.current : hostBRef.current),
    []
  );

  /** True while this player's volume is owned by a running crossfade. */
  const isFading = useCallback((p: YTPlayer | null) => {
    const f = fadeRef.current;
    if (!f || !p) return false;
    return f.incoming === p || f.outgoing === p;
  }, []);

  const stopFade = useCallback((finish: boolean) => {
    if (fadeTimerRef.current !== null) {
      window.clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    const f = fadeRef.current;
    fadeRef.current = null;
    setCrossfading(false);
    if (!f) return;
    const roomVolume = mutedRef.current ? 0 : volumeRef.current;
    try {
      if (finish) f.incoming?.setVolume(roomVolume);
    } catch {
      /* bridge busy */
    }
    try {
      // The outgoing deck becomes the idle deck: silent and out of the way.
      f.outgoing?.stopVideo();
      f.outgoing?.mute();
      f.outgoing?.setVolume(0);
    } catch {
      /* bridge busy */
    }
  }, []);

  /**
   * Overlap two songs. The incoming deck is already playing; its volume
   * ramps up on an equal-power curve while the outgoing one ramps down and
   * is then stopped. Audio never drops to silence in between.
   */
  const runCrossfade = useCallback(
    (incoming: YTPlayer | null, outgoing: YTPlayer | null, ms: number) => {
      stopFade(false);
      if (!outgoing || ms <= 0) {
        try {
          incoming?.setVolume(mutedRef.current ? 0 : volumeRef.current);
        } catch {
          /* bridge busy */
        }
        try {
          outgoing?.stopVideo();
          outgoing?.mute();
          outgoing?.setVolume(0);
        } catch {
          /* bridge busy */
        }
        return;
      }
      const createdAt = Date.now();
      // startedAt stays 0 until the incoming deck is audibly rolling.
      fadeRef.current = { incoming, outgoing, startedAt: 0, createdAt, ms };
      setCrossfading(true);
      const step = () => {
        const f = fadeRef.current;
        if (!f) return;
        const now = Date.now();
        const roomVolume = mutedRef.current ? 0 : volumeRef.current;

        if (!f.startedAt) {
          let rolling = false;
          try {
            rolling =
              f.incoming?.getPlayerState() === YT_STATE.PLAYING &&
              (f.incoming?.getCurrentTime() ?? 0) > 0.08;
          } catch {
            rolling = false;
          }
          if (!rolling && now - f.createdAt < FADE_HOLD_MAX_MS) {
            // The new song has not started yet (cold deck after a skip):
            // the old one keeps playing at full volume to cover the gap.
            try {
              f.outgoing?.setVolume(roomVolume);
            } catch {
              /* bridge busy */
            }
            try {
              f.incoming?.setVolume(0);
            } catch {
              /* bridge busy */
            }
            return;
          }
          f.startedAt = now;
        }

        const progress = (now - f.startedAt) / f.ms;
        const gains = crossfadeGains(progress);
        try {
          f.incoming?.setVolume(Math.round(roomVolume * gains.incoming));
        } catch {
          /* bridge busy */
        }
        try {
          f.outgoing?.setVolume(Math.round(roomVolume * gains.outgoing));
        } catch {
          /* bridge busy */
        }
        if (progress >= 1) stopFade(true);
      };
      step();
      fadeTimerRef.current = window.setInterval(step, FADE_STEP_MS);
    },
    [stopFade]
  );

  /* ---------- sound: ON automatically whenever the browser allows it ---------- */
  const ensureAudioActive = useCallback((p: YTPlayer | null) => {
    if (!p) return;
    const wantsSound = !mutedRef.current && volumeRef.current > 0;
    try {
      if (!wantsSound) {
        if (!p.isMuted()) p.mute();
        setSoundBlocked(false);
        return;
      }
      if (forceMutedRef.current) {
        // The browser refused audible autoplay for this page load: stay muted
        // and perfectly in sync until any gesture turns the sound on.
        if (!p.isMuted()) p.mute();
        setSoundBlocked(true);
        return;
      }
      // Always *try* with sound — most reloads are allowed to play audibly
      // and should never show a prompt.
      if (p.isMuted()) p.unMute();
      // A crossfade owns the volume of both of its decks until it finishes.
      if (!isFading(p)) p.setVolume(volumeRef.current || 80);
      setSoundBlocked(p.isMuted());
    } catch {
      /* player bridge still initializing */
    }
  }, []);

  /* ---------- global gesture → sound on ---------- */
  useEffect(() => {
    installAudioUnlockListeners();
    soundAllowedRef.current = isAudioUnlocked();
    const unlock = () => {
      soundAllowedRef.current = true;
      forceMutedRef.current = false;
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      ensureAudioActive(p);
      try {
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
    const unsubscribe = onAudioUnlock(unlock);
    // Some browsers only report activation on the *next* gesture, so keep a
    // lightweight poll alive for the first few seconds after mount.
    const poll = window.setInterval(() => {
      if (!soundAllowedRef.current && isAudioUnlocked()) unlock();
    }, 500);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
    };
  }, [ensureAudioActive]);

  /* ---------- Multi-sample NTP burst clock sync against UTC world clock ---------- */
  const runClockBurst = useCallback(async (burstCount = 3) => {
    for (let i = 0; i < burstCount; i++) {
      try {
        const t0 = performance.now();
        const res = await fetch("/api/time", { cache: "no-store" });
        const t1 = performance.now();
        if (!res.ok) {
          recordNetworkSample(t1 - t0, false);
          continue;
        }
        const data = (await res.json()) as { utcMs?: number; t?: number };
        const serverUtcMs = Number(data.utcMs ?? data.t);
        if (!Number.isFinite(serverUtcMs)) continue;

        recordNetworkSample(t1 - t0, true);
        addClockSample(t0, t1, serverUtcMs);
      } catch {
        /* keep previous anchor */
      }
      if (i < burstCount - 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await runClockBurst(3);
    })();
    const iv = window.setInterval(() => {
      if (cancelled) return;
      const np = networkProfileRef.current;
      const clk = getClockState();
      // Room polls already feed RTT samples every 1-3s; skip redundant /api/time
      // bursts in slow/Data Saver mode or when a low-RTT anchor is already fresh.
      if (np.slowNetwork || np.dataSaver) return;
      if (clk.synced && clk.bestRttMs < 350) return;
      runClockBurst(2);
    }, 45_000);
    const onVis = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      const np = networkProfileRef.current;
      const clk = getClockState();
      if (!np.slowNetwork && !np.dataSaver && (!clk.synced || clk.bestRttMs > 400)) {
        runClockBurst(2);
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
    if (!snap) return;
    seedClockFromServerNow(snap.serverNow);
  }, [snap]);

  // Mirror the shared anchor into the badge (the room poll feeds it too).
  useEffect(() => {
    return subscribeClock((next) => {
      setClockBadge((prev) =>
        prev.synced === next.synced &&
        prev.rttMs === Math.round(next.bestRttMs)
          ? prev
          : {
              ...prev,
              synced: next.synced,
              rttMs: Math.round(next.bestRttMs),
            }
      );
    });
  }, []);

  // Forward refs so sync / rebuild / recovery can call each other cleanly.
  const syncRef = useRef<(forceSeek?: boolean) => void>(() => {});
  const rebuildPlayerRef = useRef<(startMuted?: boolean) => void>(() => {});

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  /* ---------- mark playback healthy (clears every recovery flag) ---------- */
  const markHealthy = useCallback(() => {
    recoveryAttemptRef.current = 0;
    lastHealthyAtRef.current = Date.now();
    clearRecoveryTimer();
    setHealingState(false);
    setProblem("");
  }, [clearRecoveryTimer, setHealingState, setProblem]);

  /* ---------- tell the room a video simply cannot be embedded ---------- */
  const reportUnplayable = useCallback(() => {
    const s = snapRef.current;
    const np = s?.nowPlaying;
    if (!np?.videoId) return;
    const key = `${np.queueId ?? 0}:${np.videoId}`;
    if (unplayableReportedRef.current.has(key)) return;
    unplayableReportedRef.current.add(key);
    setProblem("");
    setHealingState(true);
    onPlayerActionRef
      .current("unplayable", { queueId: np.queueId, videoId: np.videoId })
      .catch(() => undefined);
  }, [setHealingState, setProblem]);

  /* ---------- the escalating recovery ladder ---------- */
  const startRecovery = useCallback(
    (kind: PlayerErrorKind) => {
      if (recoveryTimerRef.current !== null) return; // one ladder at a time
      recoveryKindRef.current = kind;
      const attempt = recoveryAttemptRef.current;
      const plan = planRecovery(kind, attempt);
      recoveryAttemptRef.current = attempt + 1;
      setHealingState(true);
      if (plan.surface) {
        setProblem(
          kind === "embed-blocked"
            ? "This video blocks embedded playback. Reconnecting — skip it if it stays stuck."
            : "Reconnecting to YouTube… this fixes itself, no refresh needed."
        );
      }

      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        const s = snapRef.current;
        if (!s?.nowPlaying) {
          setHealingState(false);
          return;
        }
        switch (plan.step) {
          case "reload":
            appliedTrackKeyRef.current = null;
            syncRef.current(false);
            break;
          case "rebuild":
            rebuildPlayerRef.current(false);
            break;
          case "rebuild-muted":
            // Blocked autoplay is the usual culprit: come back muted (always
            // allowed) so the room stays in sync, then unmute on first tap.
            // If this page has already played audio, autoplay is clearly not
            // the problem — rebuild with sound instead of silencing the room.
            if (audiblePlaybackRef.current) {
              rebuildPlayerRef.current(false);
              break;
            }
            forceMutedRef.current = true;
            setSoundBlocked(!mutedRef.current);
            rebuildPlayerRef.current(true);
            break;
          case "report-unplayable":
            reportUnplayable();
            break;
        }
      }, plan.delayMs);
    },
    [reportUnplayable, setHealingState, setProblem]
  );

  /* ---------- player event handlers ---------- */
  const currentPlayerVideoId = useCallback((p: YTPlayer | null) => {
    if (!p) return null;
    try {
      return p.getVideoData?.()?.video_id ?? null;
    } catch {
      return null;
    }
  }, []);

  const handleStateChange = useCallback(
    (state: number, target?: YTPlayer) => {
      /* The idle deck only ever reports on its preload. As soon as the
         next song starts rolling we park it back at 0: paused, buffered
         and able to resume the instant the crossfade begins. */
      if (target && target === idlePlayerRef.current) {
        if (state === YT_STATE.PLAYING && preloadStateRef.current === "loading") {
          preloadStateRef.current = "ready";
          try {
            target.pauseVideo();
            target.seekTo(0, true);
            target.mute();
            target.setVolume(0);
          } catch {
            /* bridge busy — the sync tick will retry the preload */
          }
          disableCaptions(target);
        }
        return;
      }
      if (target && target !== playerRef.current) return;
      const s = snapRef.current;

      if (state === YT_STATE.ENDED) {
        const np = s?.nowPlaying;
        const playing = currentPlayerVideoId(playerRef.current);
        // Ignore an ENDED that belongs to the previous track.
        if (!np || (playing && wantedVideoIdRef.current && playing !== wantedVideoIdRef.current)) {
          return;
        }
        const qid = appliedQidRef.current ?? np.queueId ?? null;
        const key = `${qid ?? 0}:${np.videoId}`;
        // Freeze on the last frame instead of letting the sync loop restart
        // the video while the room catches up.
        endedHoldRef.current = key;
        // If the crossfade reported this track early and the room still has
        // not moved on, the early report was rejected — the real ending is
        // worth exactly one more attempt.
        const earlyAttempt = armedEndTrackRef.current === key;
        if (endedReportedRef.current.has(key) && !earlyAttempt) return;
        armedEndTrackRef.current = null;
        endedReportedRef.current.add(key);
        let measured = 0;
        try {
          measured = playerRef.current?.getDuration() ?? 0;
        } catch {
          measured = 0;
        }
        onPlayerActionRef
          .current("ended", {
            queueId: qid,
            durationSec: Number.isFinite(measured) ? Math.round(measured) : 0,
          })
          .catch(() => undefined);
        return;
      }

      if (
        state === YT_STATE.PLAYING ||
        state === YT_STATE.BUFFERING ||
        state === YT_STATE.PAUSED ||
        state === YT_STATE.CUED
      ) {
        const playing = currentPlayerVideoId(playerRef.current);
        const onTrack =
          !wantedVideoIdRef.current ||
          !playing ||
          playing === wantedVideoIdRef.current;

        if (onTrack && state === YT_STATE.BUFFERING) {
          lastBufferedAtRef.current = Date.now();
          if (
            loadConfirmedRef.current &&
            Date.now() - lastSeekAtRef.current > 1500 &&
            bufferingStartedAtRef.current === 0
          ) {
            bufferingStartedAtRef.current = Date.now();
            bufferingReportedForEpisodeRef.current = false;
          }
        }

        if (onTrack && (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING)) {
          loadConfirmedRef.current = true;
          // It is playing again (host scrubbed back, or a fresh load).
          endedHoldRef.current = null;
          if (state === YT_STATE.PLAYING) {
            if (bufferingStartedAtRef.current > 0) {
              const bufDur = Date.now() - bufferingStartedAtRef.current;
              lastBufferedAtRef.current = Date.now();
              if (bufDur >= 1200 && !bufferingReportedForEpisodeRef.current) {
                recordBufferingStall(bufDur);
              }
              bufferingStartedAtRef.current = 0;
              bufferingReportedForEpisodeRef.current = false;
            }
            if (!forceMutedRef.current) {
              try {
                if (!playerRef.current?.isMuted()) audiblePlaybackRef.current = true;
              } catch {
                /* bridge busy */
              }
            }
          }
          // Recovered via the muted fallback but audio is actually allowed?
          // Give sound one automatic second chance before asking for a tap.
          if (
            forceMutedRef.current &&
            soundAllowedRef.current &&
            !autoUnmuteTriedRef.current
          ) {
            autoUnmuteTriedRef.current = true;
            forceMutedRef.current = false;
          }
          markHealthy();
          if (s?.nowPlaying) {
            setLoadedKey(`${s.nowPlaying.queueId ?? 0}:${s.nowPlaying.videoId}`);
          }
        }
        if (onTrack && state === YT_STATE.PAUSED && !s?.party.isPlaying) {
          markHealthy();
        }

        disableCaptions(playerRef.current);
        applyDataSaverQuality(
          playerRef.current,
          networkProfileRef.current.dataSaver
        );
        ensureAudioActive(playerRef.current);

        if (pendingSeekRef.current && state !== YT_STATE.CUED) {
          pendingSeekRef.current = false;
          const p = playerRef.current;
          if (p && s?.nowPlaying) {
            try {
              const targetSec =
                expectedPos() + (s.party.isPlaying ? SEEK_LEAD_SEC : 0);
              const cur = p.getCurrentTime?.() ?? 0;
              const snapTol = networkProfileRef.current.slowNetwork ? 3.5 : 1.2;
              if (!Number.isFinite(cur) || Math.abs(cur - targetSec) > snapTol) {
                p.seekTo(targetSec, true);
                lastSeekAtRef.current = Date.now();
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    },
    [
      expectedPos,
      ensureAudioActive,
      markHealthy,
      currentPlayerVideoId,
      setLoadedKey,
    ]
  );

  const handleError = useCallback(
    (code: number, target?: YTPlayer) => {
      if (target && target === idlePlayerRef.current) {
        // The next song cannot be preloaded: no crossfade, no early end
        // report. The active deck will hit the same error later and the
        // normal unplayable path skips it for the whole room.
        preloadedVideoRef.current = null;
        preloadStateRef.current = "idle";
        return;
      }
      if (target && target !== playerRef.current) return;
      const np = snapRef.current?.nowPlaying;
      if (!np?.videoId) return;
      // Errors raised for the track we already moved past are irrelevant.
      const playing = currentPlayerVideoId(playerRef.current);
      if (playing && wantedVideoIdRef.current && playing !== wantedVideoIdRef.current) {
        return;
      }
      startRecovery(classifyPlayerError(code));
    },
    [startRecovery, currentPlayerVideoId]
  );

  /* ---------- create or recreate the player in place ---------- */
  const mountPlayer = useCallback(
    (startMuted?: boolean) => {
      const el = hostFor(activeDeckRef.current);
      if (!el || playerRef.current || creatingRef.current) return;
      creatingRef.current = true;
      const signal = lifecycleRef.current.signal;
      const muteOnStart =
        startMuted ??
        (forceMutedRef.current ||
          mutedRef.current ||
          volumeRef.current === 0);
      createPlayer(
        el,
        {
          onReady: (p) => {
            playerRef.current = p;
            readyRef.current = true;
            lastHealthyAtRef.current = Date.now();
            disableCaptions(p);
            applyDataSaverQuality(p, networkProfileRef.current.dataSaver);
            ensureAudioActive(p);
            setReady(true);
            setProblem("");
            syncRef.current(false);
          },
          onStateChange: handleStateChange,
          onError: handleError,
          onApiChange: (p) => disableCaptions(p),
        },
        signal,
        { startMuted: muteOnStart }
      )
        .catch((err) => {
          if (signal.aborted) return;
          playerRef.current = null;
          readyRef.current = false;
          // Keep healing in the background instead of dead-ending the deck.
          startRecovery("transient");
          setProblem(
            err instanceof Error
              ? err.message
              : "YouTube player could not start."
          );
        })
        .finally(() => {
          if (!signal.aborted) creatingRef.current = false;
        });
    },
    [
      handleStateChange,
      handleError,
      ensureAudioActive,
      startRecovery,
      setProblem,
      hostFor,
    ]
  );

  /* ---------- the second deck: preload the next song ---------- */
  const mountIdleDeck = useCallback(() => {
    if (idlePlayerRef.current || idleCreatingRef.current) return;
    const el = hostFor(activeDeckRef.current === "A" ? "B" : "A");
    if (!el) return;
    idleCreatingRef.current = true;
    idleLifecycleRef.current = new AbortController();
    const signal = idleLifecycleRef.current.signal;
    createPlayer(
      el,
      {
        onReady: (p) => {
          idlePlayerRef.current = p;
          idleReadyRef.current = true;
          try {
            p.mute();
            p.setVolume(0);
          } catch {
            /* bridge busy */
          }
          disableCaptions(p);
        },
        onStateChange: handleStateChange,
        onError: handleError,
        onApiChange: (p) => disableCaptions(p),
      },
      signal,
      { startMuted: true }
    )
      .catch(() => {
        // No second deck means no crossfade — never a broken room.
        idlePlayerRef.current = null;
        idleReadyRef.current = false;
      })
      .finally(() => {
        idleCreatingRef.current = false;
      });
  }, [handleStateChange, handleError, hostFor]);

  const resetPreload = useCallback(() => {
    preloadedVideoRef.current = null;
    preloadStateRef.current = "idle";
  }, []);

  /**
   * Buffer the next song on the idle deck. `cueVideoById` does not fetch
   * media, so we start it muted and pause it back at 0 the moment it
   * reports PLAYING — that leaves a primed decoder that resumes instantly.
   */
  const preloadNext = useCallback(
    (videoId: string) => {
      if (
        networkProfileRef.current.slowNetwork ||
        networkProfileRef.current.dataSaver
      ) {
        return;
      }
      if (fadeRef.current) return; // the idle deck is busy playing a tail
      if (preloadedVideoRef.current === videoId) return;
      mountIdleDeck();
      const p = idlePlayerRef.current;
      if (!p || !idleReadyRef.current) return;
      preloadedVideoRef.current = videoId;
      preloadStateRef.current = "loading";
      try {
        p.mute();
        p.setVolume(0);
        p.loadVideoById({ videoId, startSeconds: 0 });
        disableCaptions(p);
      } catch {
        resetPreload();
      }
    },
    [mountIdleDeck, resetPreload]
  );

  const rebuildPlayer = useCallback(
    (startMuted?: boolean) => {
      // A rebuild invalidates whichever deck was fading — drop the ramp
      // before the player it points at disappears.
      stopFade(false);
      // Cancel any creation still in flight so we never end up with two
      // players racing for the same mount node.
      if (creatingRef.current) {
        try {
          lifecycleRef.current.abort();
        } catch {
          /* ignore */
        }
        lifecycleRef.current = new AbortController();
      }
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
      pendingSeekRef.current = false;
      lastHealthyAtRef.current = Date.now();
      setReady(false);
      mountPlayer(startMuted);
    },
    [mountPlayer, stopFade]
  );

  useEffect(() => {
    rebuildPlayerRef.current = rebuildPlayer;
  }, [rebuildPlayer]);

  /* ---------- hand the room over to the preloaded deck ---------- */
  const swapToIdleDeck = useCallback(
    (
      videoId: string,
      trackKey: string,
      queueId: number | null,
      ms: number
    ): boolean => {
      const outgoing = playerRef.current;
      const incoming = idlePlayerRef.current;
      if (!incoming) return false;
      const primed =
        preloadStateRef.current === "ready" &&
        preloadedVideoRef.current === videoId;

      // Roles swap: the preloaded deck becomes the room's deck.
      playerRef.current = incoming;
      idlePlayerRef.current = outgoing;
      readyRef.current = true;
      idleReadyRef.current = !!outgoing;
      const nextDeck = activeDeckRef.current === "A" ? "B" : "A";
      activeDeckRef.current = nextDeck;
      setFadeMs(ms);
      setActiveDeck(nextDeck);
      resetPreload();
      armedEndTrackRef.current = null;
      endedHoldRef.current = null;

      // Per-track bookkeeping, exactly as a fresh load would do.
      appliedTrackKeyRef.current = trackKey;
      appliedQidRef.current = queueId;
      wantedVideoIdRef.current = videoId;
      loadStartedAtRef.current = Date.now();
      lastHealthyAtRef.current = Date.now();
      lastSeekAtRef.current = Date.now();
      seeksInTrackRef.current = 0;
      bufferingStartedAtRef.current = 0;
      bufferingReportedForEpisodeRef.current = false;
      lastBufferedAtRef.current = 0;
      lastSeenPartyUpdatedAtRef.current =
        snapRef.current?.party.updatedAtMs ?? 0;
      loadConfirmedRef.current = false;
      autoUnmuteTriedRef.current = false;
      driftStrikesRef.current = 0;
      pendingSeekRef.current = false;
      resetPlaybackRate(outgoing);
      resetPlaybackRate(incoming);
      applyDataSaverQuality(incoming, networkProfileRef.current.dataSaver);
      // It is already playing, so never flash the "loading track…" overlay.
      setLoadedKey(trackKey);

      try {
        if (!mutedRef.current && volumeRef.current > 0 && !forceMutedRef.current) {
          incoming.unMute();
        }
        incoming.setVolume(0);
        const expected = expectedPos();
        let loaded: string | null = null;
        try {
          loaded = incoming.getVideoData?.()?.video_id ?? null;
        } catch {
          loaded = null;
        }
        if (loaded === videoId && primed) {
          // Preloaded and parked at 0 — resumes in a few milliseconds.
          if (expected > 0.4) incoming.seekTo(expected + SEEK_LEAD_SEC, true);
          incoming.playVideo();
        } else {
          // Cold deck (an unexpected skip): load it now. The outgoing song
          // holds at full volume until this one is audibly rolling, so the
          // room still never falls silent.
          incoming.loadVideoById({
            videoId,
            startSeconds: Math.max(0, expected + SEEK_LEAD_SEC),
            suggestedQuality: networkProfileRef.current.dataSaver
              ? "small"
              : undefined,
          });
        }
        disableCaptions(incoming);
      } catch {
        // Even a failed hand-over must not leave the old deck running
        // forever: fade it out and let the ladder heal the new one.
        startRecovery("transient");
      }

      runCrossfade(incoming, outgoing, ms);
      return true;
    },
    [
      expectedPos,
      resetPlaybackRate,
      resetPreload,
      runCrossfade,
      setLoadedKey,
      startRecovery,
    ]
  );

  /* ---------- load a track onto the live player ---------- */
  const loadTrack = useCallback(
    (
      player: YTPlayer,
      videoId: string,
      trackKey: string,
      queueId: number | null,
      shouldPlay: boolean
    ) => {
      appliedTrackKeyRef.current = trackKey;
      appliedQidRef.current = queueId;
      wantedVideoIdRef.current = videoId;
      loadStartedAtRef.current = Date.now();
      lastHealthyAtRef.current = Date.now();
      lastSeekAtRef.current = Date.now();
      seeksInTrackRef.current = 0;
      bufferingStartedAtRef.current = 0;
      bufferingReportedForEpisodeRef.current = false;
      lastBufferedAtRef.current = 0;
      lastSeenPartyUpdatedAtRef.current =
        snapRef.current?.party.updatedAtMs ?? 0;
      loadConfirmedRef.current = false;
      autoUnmuteTriedRef.current = false;
      driftStrikesRef.current = 0;
      endedHoldRef.current = null;
      pendingSeekRef.current = true;
      resetPlaybackRate(player);
      setLoadedKey(null);

      const expected = expectedPos();
      const startSeconds = Math.max(0, expected + (shouldPlay ? SEEK_LEAD_SEC : 0));
      const suggestedQuality = networkProfileRef.current.dataSaver
        ? "small"
        : undefined;

      try {
        ensureAudioActive(player);
        applyDataSaverQuality(player, networkProfileRef.current.dataSaver);
        if (shouldPlay) {
          player.loadVideoById({ videoId, startSeconds, suggestedQuality });
        } else {
          player.cueVideoById({
            videoId,
            startSeconds: Math.max(0, expected),
            suggestedQuality,
          });
        }
        disableCaptions(player);
      } catch {
        // The bridge went stale mid-transition — rebuild instead of surfacing.
        appliedTrackKeyRef.current = null;
        startRecovery("transient");
      }
    },
    [
      expectedPos,
      ensureAudioActive,
      resetPlaybackRate,
      startRecovery,
      setLoadedKey,
    ]
  );

  /* ---------- sync the player with the shared world clock ---------- */
  const sync = useCallback(
    (forceSeek = false) => {
      const s = snapRef.current;
      if (!s) return;
      if (!lastHealthyAtRef.current) lastHealthyAtRef.current = Date.now();

      const np = s.nowPlaying;
      const party = s.party;
      const { slowNetwork, dataSaver } = networkProfileRef.current;
      const browserOnline =
        typeof navigator === "undefined" || navigator.onLine !== false;

      const player = playerRef.current;
      if (np?.videoId) {
        if (!player || !readyRef.current) {
          mountPlayer();
          return;
        }
        // The iframe can be detached by extensions / aggressive mobile GC.
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
            // Brand new song: reset every per-track flag before loading.
            recoveryAttemptRef.current = 0;
            clearRecoveryTimer();
            setHealingState(false);
            setProblem("");

            /* Crossfade. Hand the room over to the second deck instead of
               tearing the audio down on this one: the outgoing song keeps
               playing (and fading) while the next one comes up, whether it
               was preloaded or has to load right now. In slow / Data Saver
               mode, stick to one deck to avoid dual-stream bandwidth stalls. */
            let outgoingState = -1;
            let outgoingRemaining = Infinity;
            try {
              outgoingState = player.getPlayerState();
              const cur = player.getCurrentTime();
              const dur = player.getDuration();
              if (dur > 0 && Number.isFinite(cur)) outgoingRemaining = dur - cur;
            } catch {
              /* bridge busy */
            }
            // Only worth a mix if the outgoing deck still has sound in it.
            const outgoingAlive =
              (outgoingState === YT_STATE.PLAYING ||
                outgoingState === YT_STATE.BUFFERING) &&
              outgoingRemaining > 0.35;
            /* A natural ending gets the full overlap. Only one guest
               actually reports the end, so decide from where the outgoing
               deck really is — every client then mixes identically. */
            const naturalEnd =
              armedEndTrackRef.current === appliedTrackKeyRef.current ||
              outgoingRemaining <= CROSSFADE_SEC + 2.5;
            const canHandOver =
              !slowNetwork &&
              !dataSaver &&
              !!idlePlayerRef.current &&
              idleReadyRef.current &&
              party.isPlaying &&
              !!appliedTrackKeyRef.current &&
              expectedPos() < CROSSFADE_SEC + 3;

            /* Never fade for longer than the outgoing song actually has
               left, or the mix would end on an abrupt cut. */
            const wanted = naturalEnd ? CROSSFADE_MS : SKIP_FADE_MS;
            const fadeLength = outgoingAlive
              ? Math.max(
                  1200,
                  Math.min(wanted, Math.round(outgoingRemaining * 1000))
                )
              : 0;

            if (
              canHandOver &&
              swapToIdleDeck(np.videoId, trackKey, np.queueId, fadeLength)
            ) {
              return;
            }

            stopFade(true);
            setFadeMs(220);
            loadTrack(player, np.videoId, trackKey, np.queueId, party.isPlaying);
            return;
          }

          const st = player.getPlayerState();
          const actualVideoId = currentPlayerVideoId(player);
          const msSinceLoad = Date.now() - loadStartedAtRef.current;

          ensureAudioActive(player);

          /* ---- track prolonged mid-song buffering so Smooth mode engages ---- */
          if (st === YT_STATE.BUFFERING && bufferingStartedAtRef.current > 0) {
            lastBufferedAtRef.current = Date.now();
            if (
              !bufferingReportedForEpisodeRef.current &&
              Date.now() - bufferingStartedAtRef.current >= 2500
            ) {
              bufferingReportedForEpisodeRef.current = true;
              recordBufferingStall(2500);
            }
          }

          /* ---- audible autoplay refused? keep the room in sync, muted ----
             This is the only reason a guest should ever see a sound prompt,
             and it is checked before the recovery ladder so a blocked
             autoplay never triggers an iframe rebuild. */
          const autoplayBlockMs =
            slowNetwork || soundAllowedRef.current
              ? AUTOPLAY_BLOCK_SLOW_MS
              : AUTOPLAY_BLOCK_MS;
          if (
            party.isPlaying &&
            !loadConfirmedRef.current &&
            // Only the very first load of a page can hit the autoplay policy;
            // after that a slow-loading track must not silence the room.
            !audiblePlaybackRef.current &&
            !forceMutedRef.current &&
            !mutedRef.current &&
            volumeRef.current > 0 &&
            msSinceLoad > autoplayBlockMs &&
            st !== YT_STATE.PLAYING &&
            st !== YT_STATE.BUFFERING
          ) {
            forceMutedRef.current = true;
            setSoundBlocked(true);
            try {
              player.mute();
              player.playVideo();
            } catch {
              /* the ladder below will pick it up */
            }
            // Give the muted attempt its own fresh grace window.
            loadStartedAtRef.current = Date.now();
            lastHealthyAtRef.current = Date.now();
            return;
          }

          /* ---- the track is over, the room just has not caught up ----
             Calling playVideo() on a finished video restarts it from zero,
             which is why the first seconds used to play over and over
             until the next song arrived. Hold still instead. */
          if (st === YT_STATE.ENDED) endedHoldRef.current = trackKey;
          if (
            endedHoldRef.current === trackKey &&
            party.durationSec > 0 &&
            expected < party.durationSec - 5
          ) {
            // The host scrubbed back into the track: it is live again.
            endedHoldRef.current = null;
          }
          const endedHold = endedHoldRef.current === trackKey;
          if (endedHold) {
            lastHealthyAtRef.current = Date.now();
            driftStrikesRef.current = 0;
          }

          if (party.isPlaying && !endedHold) {
            if (
              st !== YT_STATE.PLAYING &&
              st !== YT_STATE.BUFFERING &&
              Date.now() - lastNudgeAtRef.current > PLAY_NUDGE_COOLDOWN_MS
            ) {
              lastNudgeAtRef.current = Date.now();
              try {
                player.playVideo();
              } catch {
                /* handled by the stall detector below */
              }
            }
          } else if (!party.isPlaying) {
            if (st === YT_STATE.PLAYING || st === YT_STATE.BUFFERING) {
              player.pauseVideo();
            }
            // Nothing should keep playing behind a paused room.
            if (fadeRef.current) stopFade(true);
          }

          /* ---- automatic healing: did the load actually take? ---- */
          const wrongVideo = !!actualVideoId && actualVideoId !== np.videoId;
          const loadGraceMs = slowNetwork ? LOAD_GRACE_SLOW_MS : LOAD_GRACE_MS;
          const stallGraceMs = slowNetwork
            ? STALL_GRACE_SLOW_MS
            : STALL_GRACE_MS;

          const loadNeverStarted =
            browserOnline &&
            (!loadConfirmedRef.current || wrongVideo) &&
            shouldRetryLoad({
              expectedVideoId: np.videoId,
              actualVideoId,
              playerState: st,
              shouldPlay: party.isPlaying,
              msSinceLoad,
              graceMs: loadGraceMs,
            });

          if (loadNeverStarted && recoveryTimerRef.current === null) {
            startRecovery("transient");
          } else if (
            browserOnline &&
            !endedHold &&
            shouldHealStall({
              shouldPlay: party.isPlaying,
              playerState: st,
              msSinceHealthy: Date.now() - lastHealthyAtRef.current,
              recoveryPending: recoveryTimerRef.current !== null,
              graceMs: stallGraceMs,
            })
          ) {
            startRecovery("transient");
          } else if (st === YT_STATE.PLAYING || st === YT_STATE.BUFFERING) {
            if (!wrongVideo) loadConfirmedRef.current = true;
            lastHealthyAtRef.current = Date.now();
            if (recoveryAttemptRef.current !== 0 || playerProblemRef.current) {
              markHealthy();
            }
            if (loadedTrackKeyRef.current !== trackKey) {
              setLoadedKey(trackKey);
            }
          }

          /* ---- drift: steer first, seek only as a last resort ----
             A seek flushes YouTube's decoder buffer and forces re-buffering;
             on slow connections, aggressive seeking causes a loop of
             buffer -> behind -> seek -> re-buffer every few seconds.
             Host transport jumps (`party.updatedAtMs` changing on the same
             track) bypass cooldowns so scrubs still snap immediately. */
          let hostSeekedNow = false;
          if (party.updatedAtMs !== lastSeenPartyUpdatedAtRef.current) {
            lastSeenPartyUpdatedAtRef.current = party.updatedAtMs;
            seeksInTrackRef.current = 0;
            lastSeekAtRef.current = 0;
            lastBufferedAtRef.current = 0;
            hostSeekedNow = true;
          }

          if (st === YT_STATE.PLAYING || st === YT_STATE.PAUSED) {
            verifyPlaybackRate(player);
            const cur = player.getCurrentTime();
            if (Number.isFinite(cur)) {
              const driftSec = cur - expected;
              const driftMs = Math.round(driftSec * 1000);
              setClockBadge((prev) =>
                prev.driftMs === driftMs ? prev : { ...prev, driftMs }
              );

              // Steering needs a deck that owns its own timeline: rolling,
              // not paused, and not in the middle of a crossfade.
              const canSteer =
                rateSupportedRef.current &&
                st === YT_STATE.PLAYING &&
                party.isPlaying &&
                !fadeRef.current &&
                !scrubbingRef.current;

              const postBufferHold =
                !hostSeekedNow &&
                Date.now() - lastBufferedAtRef.current <
                  (slowNetwork
                    ? POST_BUFFER_SLOW_GRACE_MS
                    : POST_BUFFER_GRACE_MS);

              const activeDeadband = effectiveDriftDeadband({
                rateSupported: canSteer,
                slowNetwork,
              });

              if (!postBufferHold && Math.abs(driftSec) > activeDeadband) {
                driftStrikesRef.current += 1;
              } else {
                driftStrikesRef.current = 0;
              }

              const cooldownMs = Math.max(
                SEEK_COOLDOWN_MS,
                seekCooldownMs(seeksInTrackRef.current, slowNetwork)
              );
              const strikesNeeded = slowNetwork ? 4 : SEEK_STRIKES_BEFORE_SEEK;

              const plan = planDriftCorrection({
                driftSec,
                currentRate: playbackRateRef.current,
                strikes: hostSeekedNow ? strikesNeeded : driftStrikesRef.current,
                seekCooledDown:
                  hostSeekedNow ||
                  Date.now() - lastSeekAtRef.current > cooldownMs,
                force: forceSeek || (hostSeekedNow && Math.abs(driftSec) > 1.0),
                rateSupported: canSteer,
                strikesNeeded,
                slowNetwork,
                postBufferHold,
              });

              if (plan.kind === "seek") {
                resetPlaybackRate(player);
                const targetSec = expected + (party.isPlaying ? SEEK_LEAD_SEC : 0);
                player.seekTo(targetSec, true);
                lastSeekAtRef.current = Date.now();
                seeksInTrackRef.current += 1;
                driftStrikesRef.current = 0;
              } else if (plan.kind === "rate") {
                applyPlaybackRate(player, plan.rate);
              } else if (!canSteer && playbackRateRef.current !== RATE_NORMAL) {
                resetPlaybackRate(player);
              }
            }

            /* ---- fix a wrong duration coming from the search provider ----
               A too-short duration freezes the progress bar and makes the
               server cut the song off early; a too-long one leaves a dead
               gap. Report the real one once, a few seconds in. */
            if (
              st === YT_STATE.PLAYING &&
              reportedDurationRef.current !== trackKey &&
              msSinceLoad > 5000
            ) {
              const realDuration = player.getDuration();
              if (
                Number.isFinite(realDuration) &&
                realDuration > 20 &&
                Math.abs(realDuration - (party.durationSec || 0)) > 2
              ) {
                reportedDurationRef.current = trackKey;
                onPlayerActionRef
                  .current("duration", {
                    queueId: np.queueId,
                    durationSec: Math.round(realDuration),
                  })
                  .catch(() => undefined);
              }
            }
          }

          /* ---- crossfade scheduling ----
             Skipped when slowNetwork or dataSaver is active so a second
             YouTube stream never competes with the active song. */
          const nextUp = s.queue[0] ?? null;

          if (
            !slowNetwork &&
            !dataSaver &&
            !idlePlayerRef.current &&
            !idleCreatingRef.current &&
            loadConfirmedRef.current &&
            msSinceLoad > 3000 &&
            Date.now() - lastIdleMountAtRef.current > 10000
          ) {
            lastIdleMountAtRef.current = Date.now();
            mountIdleDeck();
          }

          /* How much audio is really left. The room's durationSec is only
             as good as the search provider's metadata, so the player's own
             clock — which decides when sound actually stops — wins. */
          let playerRemaining: number | null = null;
          let measuredDuration = 0;
          try {
            measuredDuration = player.getDuration();
            const cur = player.getCurrentTime();
            if (measuredDuration > 0 && Number.isFinite(cur)) {
              playerRemaining = measuredDuration - cur;
            }
          } catch {
            playerRemaining = null;
          }
          const serverRemaining =
            party.durationSec > 0 ? party.durationSec - expected : Infinity;
          const remaining = effectiveRemainingSec(
            serverRemaining,
            st === YT_STATE.PLAYING ? playerRemaining : null
          );

          if (nextUp && party.isPlaying && !endedHold && !slowNetwork && !dataSaver) {
            /* Preload the next song only inside the PRELOAD_LEAD_SEC window
               (and only when the current stream hasn't buffered recently) so
               we don't saturate bandwidth or waste data on skipped tracks. */
            const wantsPreload =
              preloadedVideoRef.current !== nextUp.videoId &&
              !fadeRef.current &&
              loadConfirmedRef.current &&
              remaining <= PRELOAD_LEAD_SEC &&
              Date.now() - lastBufferedAtRef.current > 8000 &&
              Date.now() - lastPreloadAtRef.current > 4000;
            if (wantsPreload) {
              lastPreloadAtRef.current = Date.now();
              preloadNext(nextUp.videoId);
            }

            /* Park the preloaded deck by polling as well as by event: if a
               single state callback is missed the deck would stream the
               whole next song in the background and never report ready,
               which is exactly what silently disabled the crossfade. */
            if (preloadStateRef.current === "loading" && !fadeRef.current) {
              const idle = idlePlayerRef.current;
              try {
                const idleState = idle?.getPlayerState();
                const idleAt = idle?.getCurrentTime() ?? 0;
                const idleVideo = idle?.getVideoData?.()?.video_id ?? null;
                if (idle && idleVideo === preloadedVideoRef.current) {
                  if (
                    idleState === YT_STATE.PLAYING ||
                    idleState === YT_STATE.BUFFERING
                  ) {
                    if (idleAt > 0.05) {
                      idle.pauseVideo();
                      idle.seekTo(0, true);
                      idle.mute();
                      idle.setVolume(0);
                      preloadStateRef.current = "ready";
                    }
                  } else if (
                    idleState === YT_STATE.PAUSED ||
                    idleState === YT_STATE.CUED
                  ) {
                    idle.mute();
                    idle.setVolume(0);
                    preloadStateRef.current = "ready";
                  }
                }
              } catch {
                /* bridge busy — try again next tick */
              }
            }

            /* Move the room on early so the next song overlaps this one.
               This no longer waits for the preload: the overlap needs the
               *outgoing* deck to still have audio, which is exactly what
               an early switch guarantees. */
            if (
              shouldArmEarlyEnd({
                remainingSec: remaining,
                hasNext: true,
                isPlaying: party.isPlaying,
                durationSec: Math.max(party.durationSec, measuredDuration || 0),
                alreadyReported: endedReportedRef.current.has(trackKey),
              })
            ) {
              endedReportedRef.current.add(trackKey);
              armedEndTrackRef.current = trackKey;
              onPlayerActionRef
                .current("ended", {
                  queueId: np.queueId,
                  durationSec: Number.isFinite(measuredDuration)
                    ? Math.round(measuredDuration)
                    : 0,
                })
                .catch(() => undefined);
            }
          }
        } else if (appliedTrackKeyRef.current !== null) {
          appliedTrackKeyRef.current = null;
          appliedQidRef.current = null;
          wantedVideoIdRef.current = null;
          setLoadedKey(null);
          clearRecoveryTimer();
          setHealingState(false);
          setProblem("");
          try {
            player.stopVideo();
          } catch {
            /* ignore */
          }
        }
      } catch {
        // Any exception from the bridge means the iframe is unusable → heal.
        startRecovery("transient");
      }
    },
    [
      expectedPos,
      mountPlayer,
      mountIdleDeck,
      preloadNext,
      rebuildPlayer,
      ensureAudioActive,
      loadTrack,
      startRecovery,
      stopFade,
      swapToIdleDeck,
      clearRecoveryTimer,
      currentPlayerVideoId,
      markHealthy,
      setHealingState,
      setProblem,
      setLoadedKey,
      applyPlaybackRate,
      resetPlaybackRate,
      verifyPlaybackRate,
    ]
  );

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  // Mount the player once and keep it alive across tracks.
  useEffect(() => {
    lifecycleRef.current = new AbortController();
    mountPlayer();
    return () => {
      lifecycleRef.current.abort();
      idleLifecycleRef.current.abort();
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      if (fadeTimerRef.current !== null) {
        window.clearInterval(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
      fadeRef.current = null;
      try {
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      try {
        idlePlayerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      idlePlayerRef.current = null;
      idleReadyRef.current = false;
      idleCreatingRef.current = false;
      preloadedVideoRef.current = null;
      preloadStateRef.current = "idle";
      readyRef.current = false;
      creatingRef.current = false;
      appliedTrackKeyRef.current = null;
      appliedQidRef.current = null;
      wantedVideoIdRef.current = null;
    };
  }, [mountPlayer]);

  // A new track resets per-track recovery state and syncs immediately (on
  // the next frame — sync() sets state, and the effect phase is the one
  // place that must not).
  useEffect(() => {
    recoveryAttemptRef.current = 0;
    lastHealthyAtRef.current = Date.now();
    seeksInTrackRef.current = 0;
    bufferingStartedAtRef.current = 0;
    bufferingReportedForEpisodeRef.current = false;
    lastBufferedAtRef.current = 0;
    setProblem("");
    setHealingState(false);
    const id = window.setTimeout(() => sync(false), 0);
    return () => window.clearTimeout(id);
  }, [snap?.nowPlaying?.queueId, snap?.nowPlaying?.videoId, setHealingState, sync]);

  // Keep the player tightly synced with the world clock (every 500ms).
  useEffect(() => {
    const t = setInterval(() => sync(false), 500);
    return () => clearInterval(t);
  }, [sync]);

  // A fresh snapshot is applied on the next frame rather than inside the
  // effect itself: sync() can set state, and doing that synchronously during
  // the effect phase cascades an extra render of the whole deck.
  useEffect(() => {
    const id = window.setTimeout(() => sync(false), 0);
    return () => window.clearTimeout(id);
  }, [snap, sync]);

  // Returning to the tab after a mobile freeze: re-check without force-seeking
  // (focus/visibility changes shouldn't flush a healthy YouTube buffer).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      lastHealthyAtRef.current = Date.now();
      sync(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [sync]);

  // When a fresh server state arrives, stop overriding with optimistic UI.
  useEffect(() => {
    if (!snap) return;
    if (lastServerUpdateRef.current !== snap.party.updatedAtMs) {
      lastServerUpdateRef.current = snap.party.updatedAtMs;
      setUiPlaying(null);
    }
  }, [snap]);

  /* ---------- local progress anchored to the world clock ----------
     The exact position is broadcast through a tiny store (100ms, no React
     re-render) so the lyrics can follow it precisely, while this component's
     own progress bar re-renders at a calm 250ms. */
  useEffect(() => {
    const publish = () => {
      const s = snapRef.current;
      if (!s || !s.nowPlaying) {
        setPlayhead(0);
        return 0;
      }
      if (scrubbingRef.current) return null;
      const { positionSec } = computeExpectedPosition(s.party, worldNowMs());
      setPlayhead(positionSec);
      return positionSec;
    };
    const fast = setInterval(publish, 100);
    const slow = setInterval(() => {
      const value = publish();
      if (value !== null) setDisplayPos(value);
    }, 250);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [worldNowMs]);

  /* ---------- user controls ---------- */
  const enableSound = useCallback(() => {
    markAudioUnlocked();
    soundAllowedRef.current = true;
    forceMutedRef.current = false;
    mutedRef.current = false;
    setMuted(false);
    if (volumeRef.current === 0) {
      volumeRef.current = 80;
      setVolume(80);
    }
    const p = playerRef.current;
    if (!p) return;
    try {
      p.unMute();
      p.setVolume(volumeRef.current || 80);
      setSoundBlocked(p.isMuted());
      if (snapRef.current?.party.isPlaying) p.playVideo();
    } catch {
      /* ignore */
    }
  }, []);

  const toggleMute = () => {
    const p = playerRef.current;
    if (muted) {
      markAudioUnlocked();
      soundAllowedRef.current = true;
      forceMutedRef.current = false;
      mutedRef.current = false;
      setMuted(false);
      if (volumeRef.current === 0) {
        volumeRef.current = 80;
        setVolume(80);
      }
      if (p) {
        try {
          p.unMute();
          p.setVolume(volumeRef.current || 80);
          setSoundBlocked(p.isMuted());
          if (snapRef.current?.party.isPlaying) p.playVideo();
        } catch {
          /* ignore */
        }
      }
    } else {
      mutedRef.current = true;
      setMuted(true);
      setSoundBlocked(false);
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
    markAudioUnlocked();
    soundAllowedRef.current = true;
    forceMutedRef.current = false;
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
        setSoundBlocked(false);
      } else {
        mutedRef.current = false;
        setMuted(false);
        p.unMute();
        setSoundBlocked(p.isMuted());
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
            const cur = p.getCurrentTime?.();
            if (!Number.isFinite(cur) || Math.abs(cur - displayPos) > 0.5) {
              p.seekTo(displayPos + SEEK_LEAD_SEC, true);
            }
            p.playVideo();
          } catch {
            /* ignore */
          }
        }
      } else if (action === "skip") {
        setProblem("");
        setHealingState(false);
        recoveryAttemptRef.current = 0;
        clearRecoveryTimer();
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
    setPlayhead(sec);
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
    await runClockBurst(2);
    sync(true);
  };

  /* Stable handles for the window-event and Media Session listeners, which
     are registered once but must always call the current closures. */
  const toggleMuteRef = useRef(toggleMute);
  const seekLocalRef = useRef(seekLocal);
  const commitSeekRef = useRef(commitSeek);
  const runClockBurstRef = useRef(runClockBurst);
  const displayPosRef = useRef(displayPos);
  const isAdminRef = useRef(isAdmin);
  useEffect(() => {
    toggleMuteRef.current = toggleMute;
    seekLocalRef.current = seekLocal;
    commitSeekRef.current = commitSeek;
    runClockBurstRef.current = runClockBurst;
    displayPosRef.current = displayPos;
    isAdminRef.current = isAdmin;
  });

  const manualRetry = () => {
    recoveryAttemptRef.current = 0;
    clearRecoveryTimer();
    unplayableReportedRef.current.clear();
    setProblem("");
    setHealingState(true);
    enableSound();
    rebuildPlayer(false);
  };

  const np = snap?.nowPlaying ?? null;
  const duration = snap?.party.durationSec ?? 0;
  const isPlaying = uiPlaying ?? (!!snap?.party.isPlaying && !!np);
  const progress = duration > 0 ? Math.min(1, displayPos / duration) : 0;
  const currentTrackKey = np ? `${np.queueId ?? 0}:${np.videoId}` : null;
  const switching = !!np && loadedTrackKey !== currentTrackKey;

  /* ---------- room-wide shortcuts and the lock screen ----------
     Both reach the deck through a window event instead of four more props,
     which would re-render the whole room every time one of them changed. */
  useEffect(() => {
    return onRoomEvent((event) => {
      if (event.type === "toggle-mute") {
        toggleMuteRef.current();
        return;
      }
      if (event.type === "force-resync") {
        // The connection came back after a genuine outage: re-anchor the
        // clock and jump onto the room timeline rather than drifting back.
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          return;
        }
        const isSlow =
          networkProfileRef.current.slowNetwork ||
          networkProfileRef.current.dataSaver;
        void runClockBurstRef.current(isSlow ? 1 : 2);
        syncRef.current(true);
        return;
      }
      if (event.type === "seek-by") {
        if (!isAdminRef.current) return;
        const total = snapRef.current?.party.durationSec ?? 0;
        const target = Math.max(
          0,
          total > 0
            ? Math.min(total - 0.5, displayPosRef.current + event.seconds)
            : displayPosRef.current + event.seconds
        );
        seekLocalRef.current(target);
        commitSeekRef.current(target);
      }
    });
  }, []);

  /* ---------- Media Session: lock screen, notification, headphones ----------
     Without this a phone shows a dead pause button and no artwork. Hosts get
     real transport controls (they drive the whole room); guests get
     play/pause mapped to their own speaker, which doubles as the gesture
     that unlocks audio. */
  useEffect(() => {
    if (!np) {
      clearMediaSession();
      return;
    }
    setMediaSessionTrack({
      title: np.title,
      artist: np.artist || `added by ${np.addedByName || "the room"}`,
      album: "vibe·room",
      videoId: np.videoId,
      thumbnail: np.thumbnail,
    });
    setMediaSessionHandlers(
      isAdmin
        ? {
            onPlay: () => {
              void onPlayerActionRef.current("resume", {
                positionSec: displayPosRef.current,
              });
            },
            onPause: () => {
              void onPlayerActionRef.current("pause", {
                positionSec: displayPosRef.current,
              });
            },
            onNext: () => {
              void onPlayerActionRef.current("skip");
            },
            onSeekBackward: (offset) => {
              const target = Math.max(0, displayPosRef.current - offset);
              seekLocalRef.current(target);
              commitSeekRef.current(target);
            },
            onSeekForward: (offset) => {
              const target = displayPosRef.current + offset;
              seekLocalRef.current(target);
              commitSeekRef.current(target);
            },
            onSeekTo: (position) => {
              seekLocalRef.current(position);
              commitSeekRef.current(position);
            },
          }
        : {
            // A guest cannot pause the party, only their own speaker.
            onPlay: () => {
              if (mutedRef.current) toggleMuteRef.current();
            },
            onPause: () => {
              if (!mutedRef.current) toggleMuteRef.current();
            },
          }
    );
    return () => {
      setMediaSessionHandlers({});
    };
  }, [np, isAdmin]);

  useEffect(() => {
    setMediaSessionPlaybackState(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    if (!np || !duration) return;
    const push = () =>
      setMediaSessionPosition({
        durationSec: duration,
        positionSec: displayPosRef.current,
        playbackRate: playbackRateRef.current,
      });
    push();
    // The lock-screen scrubber only needs a coarse refresh.
    const iv = window.setInterval(push, 5000);
    return () => window.clearInterval(iv);
  }, [np, duration, isPlaying]);

  const handleTilt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5) * 10;
    const y = ((e.clientY - r.top) / r.height - 0.5) * -10;
    setTilt({ x: y, y: x });
  };

  const posterWidth =
    "mx-auto w-full max-w-[min(100%,34dvh,440px)] sm:max-w-[min(100%,38dvh,440px)] md:max-w-[min(100%,40dvh,440px)] lg:max-w-[min(100%,46dvh,460px)]";

  const saverScale =
    networkProfile.dataSaver && posterPx > DATA_SAVER_IFRAME_PX
      ? posterPx / DATA_SAVER_IFRAME_PX
      : 1;
  const saverViewportStyle =
    saverScale > 1
      ? {
          width: `${DATA_SAVER_IFRAME_PX}px`,
          height: `${DATA_SAVER_IFRAME_PX}px`,
          transform: `scale(${saverScale})`,
          transformOrigin: "top left",
        }
      : undefined;

  return (
    <div className="flex w-full flex-col items-center justify-center animate-fade-up">
      {/* Poster / Empty Deck */}
      <div
        className={`relative ${posterWidth}`}
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
          <div
            ref={posterBoxRef}
            className="relative aspect-square w-full overflow-hidden rounded-[2.05rem] bg-black shadow-[0_40px_110px_rgba(0,0,0,0.8)]"
          >
            {/* Two persistent YouTube decks. One owns the current track, the
                other preloads the next one and plays the outgoing tail, so a
                song change cross-dissolves instead of cutting to black. */}
            <div
              className={`absolute inset-0 z-0 ${
                np ? "" : "pointer-events-none opacity-0"
              }`}
            >
              <div
                ref={hostARef}
                className={`${
                  saverScale > 1 ? "absolute left-0 top-0" : "absolute inset-0"
                } [&>div]:h-full [&>div]:w-full [&>iframe]:h-full [&>iframe]:w-full`}
                style={{
                  ...saverViewportStyle,
                  opacity: activeDeck === "A" ? 1 : 0,
                  transition: `opacity ${fadeMs}ms linear`,
                }}
              />
              <div
                ref={hostBRef}
                className={`${
                  saverScale > 1 ? "absolute left-0 top-0" : "absolute inset-0"
                } [&>div]:h-full [&>div]:w-full [&>iframe]:h-full [&>iframe]:w-full`}
                style={{
                  ...saverViewportStyle,
                  opacity: activeDeck === "B" ? 1 : 0,
                  transition: `opacity ${fadeMs}ms linear`,
                }}
              />
            </div>

            {/* Tap-anywhere sound unlock. Also shields YouTube's own overlay
                buttons so a stray tap can never pause one guest out of sync. */}
            {np && (
              <div
                className="absolute inset-0 z-10"
                onPointerDown={enableSound}
                aria-hidden
              />
            )}

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
                <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-black/85 via-transparent to-black/45" />
                <div className="pointer-events-none absolute inset-0 z-10 opacity-[0.07] [background:repeating-linear-gradient(0deg,transparent_0_2px,#fff_2px_3px)]" />

                {/* top strip */}
                <div className="absolute left-0 right-0 top-0 z-20 flex items-start justify-between p-3 sm:p-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {crossfading ? (
                      <span className="flex items-center gap-1.5 rounded-full border border-cyan-300/40 bg-black/60 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-200 backdrop-blur-md">
                        <Shuffle className="h-3 w-3" /> mixing
                      </span>
                    ) : isPlaying ? (
                      <span className="animate-pulse-ring flex items-center gap-1.5 rounded-full border border-red-400/40 bg-black/60 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-red-300 backdrop-blur-md">
                        <Signal className="h-3 w-3" /> live
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-300 backdrop-blur-md">
                        <Pause className="h-3 w-3" /> paused
                      </span>
                    )}

                    {isAdmin && (
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
                    )}
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

                {/* sound unlock (only when the browser refuses autoplay audio) */}
                {soundBlocked && !playerProblem && (
                  <button
                    type="button"
                    onClick={enableSound}
                    className="absolute left-1/2 top-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 animate-pulse-ring items-center gap-2 rounded-2xl border border-white/20 bg-black/75 px-4 py-3 backdrop-blur-md transition hover:bg-black/90"
                  >
                    <Volume2 className="h-4 w-4 text-cyan-300" />
                    <span className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-white">
                      Tap for sound
                    </span>
                  </button>
                )}

                {/* track switching / healing overlay */}
                {(switching || healing) && !playerProblem && (
                  <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/45">
                    <div className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-black/65 px-4 py-3 backdrop-blur-md">
                      <LoaderCircle className="h-4 w-4 animate-spin text-fuchsia-300" />
                      <span className="font-display text-[11px] font-bold uppercase tracking-[0.22em] text-white">
                        {healing ? "reconnecting…" : "loading track…"}
                      </span>
                    </div>
                  </div>
                )}

                {playerProblem && (
                  <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/75 p-5 text-center backdrop-blur-sm">
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
                          onClick={manualRetry}
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
                <div className="pointer-events-none absolute bottom-4 right-4 z-20 hidden sm:block">
                  <div
                    className={`vinyl relative h-16 w-16 rounded-full lg:h-20 lg:w-20 ${
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
                <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 p-4 pr-24 sm:p-6 sm:pr-28">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.28em] text-cyan-300/90">
                    <UserRound className="h-3 w-3" />
                    queued by {np.addedByName}
                  </p>
                  <h2 className="marquee-hover font-display text-base font-bold leading-tight text-white [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden sm:text-lg lg:text-xl">
                    {np.title}
                  </h2>
                  {np.artist && (
                    <p className="mt-1 truncate font-serif text-sm italic text-zinc-300 sm:text-base">
                      {np.artist}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Progress — read-only for guests, scrubbable for the host */}
      {np && (
        <div className={`mt-2.5 sm:mt-3.5 ${posterWidth}`}>
          <div className="flex items-center justify-between text-[11px] font-semibold tabular-nums text-zinc-500">
            <span>{formatDuration(displayPos)}</span>
            {isAdmin && (
              <span className="text-[10px] text-zinc-600">
                {Math.floor((displayPos % 1) * 1000)
                  .toString()
                  .padStart(3, "0")}
                ms
              </span>
            )}
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
      )}

      {/* Deck controls are the host's job only */}
      {np && isAdmin && (
        <>
          <div
            className={`mt-2.5 flex flex-wrap items-center justify-center gap-2 sm:mt-3.5 sm:gap-2.5 ${posterWidth}`}
          >
            <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
              <button
                onClick={toggleMute}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/10 hover:text-white sm:h-10 sm:w-10"
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

            <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
              <button
                onClick={() => adminTransport(isPlaying ? "pause" : "resume")}
                className="flex h-9 w-14 items-center justify-center rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_24px_rgba(168,85,247,0.4)] transition hover:scale-105 sm:h-10"
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
                className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/10 hover:text-white sm:h-10 sm:w-10"
                title="Skip track"
              >
                <SkipForward className="h-4.5 w-4.5" />
              </button>
            </div>

            {!ready && (
              <span className="text-xs text-zinc-500">warming up the deck…</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
