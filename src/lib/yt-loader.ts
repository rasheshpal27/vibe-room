"use client";

/* Minimal typings for the YouTube IFrame Player API */
export interface YTPlayer {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void;
  cueVideoById(videoId: string): void;
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
  destroy(): void;
}

export const YT_STATE = {
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

function waitForYT(resolve: (yt: any) => void, reject: (err: Error) => void) {
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (window.YT?.Player) {
      window.clearInterval(timer);
      resolve(window.YT);
      return;
    }
    if (Date.now() - started > 8000) {
      window.clearInterval(timer);
      reject(new Error("YouTube player API did not load. Check ad blockers or network restrictions."));
    }
  }, 100);
}

export function loadYouTubeAPI(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  if (window.YT?.Player) return Promise.resolve(window.YT);

  if (!loadingPromise) {
    loadingPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        if (window.YT?.Player) resolve(window.YT);
      };

      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        tag.async = true;
        tag.onerror = () => reject(new Error("Could not download YouTube player API."));
        document.head.appendChild(tag);
      }

      // Some browsers/extensions load the API but miss the global callback.
      waitForYT(resolve, reject);
    });
  }

  return loadingPromise;
}

export function createPlayer(
  el: HTMLElement,
  handlers: {
    onReady: (p: YTPlayer) => void;
    onStateChange: (state: number) => void;
    onError?: (code: number) => void;
  }
): Promise<YTPlayer> {
  return loadYouTubeAPI().then(
    (YT) =>
      new Promise<YTPlayer>((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (!settled) reject(new Error("YouTube player iframe did not become ready."));
        }, 8000);

        const player: YTPlayer = new YT.Player(el, {
          width: "100%",
          height: "100%",
          host: "https://www.youtube-nocookie.com",
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            enablejsapi: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            origin: window.location.origin,
            playsinline: 1,
            rel: 0,
          },
          events: {
            onReady: () => {
              settled = true;
              window.clearTimeout(timeout);
              handlers.onReady(player);
              resolve(player);
            },
            onStateChange: (e: { data: number }) => handlers.onStateChange(e.data),
            onError: (e: { data: number }) => handlers.onError?.(e.data),
          },
        });
      })
  );
}
