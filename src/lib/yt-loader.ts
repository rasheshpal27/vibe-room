"use client";

/* Minimal typings for the YouTube IFrame Player API */
export interface YTPlayer {
  loadVideoById(
    opts:
      | string
      | { videoId: string; startSeconds?: number; suggestedQuality?: string }
  ): void;
  cueVideoById(
    videoId:
      | string
      | { videoId: string; startSeconds?: number; suggestedQuality?: string }
  ): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(v: number): void;
  getIframe(): HTMLIFrameElement;
  destroy(): void;
  /** Available once the player has loaded a video. */
  getVideoData?(): { video_id?: string; title?: string; author?: string };
  /** Advisory quality hint — used by Data Saver to prefer low-bitrate video. */
  setPlaybackQuality?(suggestedQuality: string): void;
  /** Pitch-preserving speed control — used for inaudible drift correction. */
  setPlaybackRate?(rate: number): void;
  getPlaybackRate?(): number;
  getAvailablePlaybackRates?(): number[];
  /** Module controls — used to force YouTube's own captions off. */
  loadModule?(module: string): void;
  unloadModule?(module: string): void;
  setOption?(module: string, option: string, value: unknown): void;
  getOptions?(module?: string): string[] | undefined;
}

export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
};

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loadingPromise: Promise<any> | null = null;

export function loadYouTubeAPI(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loadingPromise) {
    loadingPromise = new Promise((resolve, reject) => {
      let tag = document.querySelector<HTMLScriptElement>(
        'script[src="https://www.youtube.com/iframe_api"]'
      );
      const finish = (error?: Error) => {
        clearInterval(poll);
        clearTimeout(timeout);
        tag?.removeEventListener("error", onError);
        if (error) {
          tag?.remove();
          reject(error);
        } else resolve(window.YT);
      };
      const onError = () =>
        finish(new Error("Could not download YouTube player API. Try again."));
      const poll = window.setInterval(() => {
        if (window.YT?.Player) finish();
      }, 100);
      const timeout = window.setTimeout(
        () =>
          finish(
            new Error(
              "YouTube API timed out. Check your connection or ad blocker and retry."
            )
          ),
        15000
      );
      if (!tag) {
        tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        tag.async = true;
        tag.addEventListener("error", onError);
        document.head.appendChild(tag);
      } else tag.addEventListener("error", onError);
    }).catch((error) => {
      loadingPromise = null;
      throw error;
    });
  }
  return loadingPromise;
}

/** Force YouTube's own subtitle track off — the room shows its own lyrics. */
export function disableCaptions(player: YTPlayer | null | undefined) {
  if (!player) return;
  try {
    player.unloadModule?.("captions");
  } catch {
    /* module may not be loaded yet */
  }
  try {
    player.unloadModule?.("cc");
  } catch {
    /* older module name */
  }
  try {
    player.setOption?.("captions", "track", {});
  } catch {
    /* ignore */
  }
}

/**
 * Hint a lower video resolution when Data Saver is active so YouTube spends
 * bandwidth on audio rather than HD video frames. Safe no-op on builds that
 * ignore advisory quality hints (combined with compact iframe sizing).
 */
export function applyDataSaverQuality(
  player: YTPlayer | null | undefined,
  dataSaver: boolean
) {
  if (!player?.setPlaybackQuality) return;
  try {
    player.setPlaybackQuality(dataSaver ? "small" : "default");
  } catch {
    /* advisory only */
  }
}

export interface CreatePlayerOptions {
  /** Start muted so blocked autoplay still starts (and stays in sync). */
  startMuted?: boolean;
}

export function createPlayer(
  el: HTMLElement,
  handlers: {
    onReady: (p: YTPlayer) => void;
    onStateChange: (state: number, player?: YTPlayer) => void;
    onError?: (code: number, player?: YTPlayer) => void;
    onApiChange?: (player: YTPlayer) => void;
  },
  signal?: AbortSignal,
  options: CreatePlayerOptions = {}
): Promise<YTPlayer> {
  return loadYouTubeAPI().then(
    (YT) =>
      new Promise<YTPlayer>((resolve, reject) => {
        if (signal?.aborted || !el.isConnected) {
          reject(new Error("Player creation cancelled."));
          return;
        }
        // YouTube replaces its target node with an iframe. Keep React's host
        // container intact so we can cleanly recreate the player without unmounting.
        const target = document.createElement("div");
        el.replaceChildren(target);
        let settled = false;
        let player: YTPlayer;
        const cancel = () => {
          settled = true;
          window.clearTimeout(timeout);
          signal?.removeEventListener("abort", cancel);
          try {
            player?.destroy();
          } catch {
            /* already removed */
          }
          target.remove();
          reject(
            new Error("Player creation cancelled or timed out. Please retry.")
          );
        };
        const timeout = window.setTimeout(() => {
          if (!settled) cancel();
        }, 15000);

        signal?.addEventListener("abort", cancel, { once: true });
        player = new YT.Player(target, {
          width: "100%",
          height: "100%",
          playerVars: {
            autoplay: 1,
            // Never show YouTube's own subtitles — the room renders synced lyrics.
            cc_load_policy: 0,
            controls: 0,
            disablekb: 1,
            enablejsapi: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            mute: options.startMuted ? 1 : 0,
            origin: window.location.origin,
            playsinline: 1,
            rel: 0,
          },
          events: {
            onReady: () => {
              disableCaptions(player);
              if (settled) return;
              settled = true;
              window.clearTimeout(timeout);
              handlers.onReady(player);
              resolve(player);
            },
            onStateChange: (e: { data: number }) =>
              !signal?.aborted && handlers.onStateChange(e.data, player),
            onError: (e: { data: number }) =>
              !signal?.aborted && handlers.onError?.(e.data, player),
            onApiChange: () => {
              // Modules (captions included) are only addressable from here.
              disableCaptions(player);
              if (!signal?.aborted) handlers.onApiChange?.(player);
            },
          },
        });
      })
  );
}
