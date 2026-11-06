/**
 * Lock-screen / notification controls.
 *
 * A phone playing music from a browser tab shows whatever the Media Session
 * API was told — without it the OS shows "vibe-room" and a dead pause button
 * that does nothing. With it you get artwork, the title, and transport keys
 * that work from the lock screen, headphones and car stereos.
 */

export interface MediaSessionTrack {
  title: string;
  artist: string;
  album?: string;
  videoId: string;
  thumbnail?: string;
}

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onNext?: () => void;
  onSeekBackward?: (offsetSec: number) => void;
  onSeekForward?: (offsetSec: number) => void;
  onSeekTo?: (positionSec: number) => void;
}

type MediaSessionLike = {
  metadata: unknown;
  playbackState: "none" | "paused" | "playing";
  setActionHandler: (action: string, handler: ((d?: unknown) => void) | null) => void;
  setPositionState?: (state: {
    duration: number;
    playbackRate: number;
    position: number;
  }) => void;
};

function session(): MediaSessionLike | null {
  if (typeof navigator === "undefined") return null;
  const ms = (navigator as unknown as { mediaSession?: MediaSessionLike })
    .mediaSession;
  return ms ?? null;
}

export function mediaSessionSupported(): boolean {
  return session() !== null;
}

/** YouTube serves several sizes; the OS picks the one it likes. */
export function artworkFor(videoId: string, thumbnail?: string) {
  const sized = (name: string, sizes: string) => ({
    src: `https://i.ytimg.com/vi/${videoId}/${name}.jpg`,
    sizes,
    type: "image/jpeg",
  });
  const art = [
    sized("mqdefault", "320x180"),
    sized("hqdefault", "480x360"),
    sized("maxresdefault", "1280x720"),
  ];
  if (thumbnail && !thumbnail.includes("i.ytimg.com")) {
    art.unshift({ src: thumbnail, sizes: "480x360", type: "image/jpeg" });
  }
  return art;
}

export function setMediaSessionTrack(track: MediaSessionTrack | null) {
  const ms = session();
  if (!ms) return;
  if (!track) {
    ms.metadata = null;
    ms.playbackState = "none";
    return;
  }
  const MM = (globalThis as unknown as { MediaMetadata?: new (init: unknown) => unknown })
    .MediaMetadata;
  if (!MM) return;
  try {
    ms.metadata = new MM({
      title: track.title || "vibe-room",
      artist: track.artist || "vibe-room",
      album: track.album || "vibe-room",
      artwork: artworkFor(track.videoId, track.thumbnail),
    });
  } catch {
    /* metadata is a nicety, never a failure */
  }
}

export function setMediaSessionPlaybackState(isPlaying: boolean) {
  const ms = session();
  if (!ms) return;
  try {
    ms.playbackState = isPlaying ? "playing" : "paused";
  } catch {
    /* ignore */
  }
}

export function setMediaSessionPosition(opts: {
  durationSec: number;
  positionSec: number;
  playbackRate?: number;
}) {
  const ms = session();
  if (!ms?.setPositionState) return;
  const duration = Math.max(0, opts.durationSec || 0);
  if (!duration) return;
  try {
    ms.setPositionState({
      duration,
      playbackRate: opts.playbackRate && opts.playbackRate > 0 ? opts.playbackRate : 1,
      position: Math.min(Math.max(0, opts.positionSec || 0), duration),
    });
  } catch {
    /* Safari throws when position > duration mid-crossfade */
  }
}

const ALL_ACTIONS = [
  "play",
  "pause",
  "nexttrack",
  "previoustrack",
  "seekbackward",
  "seekforward",
  "seekto",
  "stop",
] as const;

export function setMediaSessionHandlers(handlers: MediaSessionHandlers) {
  const ms = session();
  if (!ms) return;
  const set = (action: string, fn: ((d?: unknown) => void) | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* unsupported action on this browser */
    }
  };
  for (const action of ALL_ACTIONS) set(action, null);

  if (handlers.onPlay) set("play", () => handlers.onPlay?.());
  if (handlers.onPause) set("pause", () => handlers.onPause?.());
  if (handlers.onNext) set("nexttrack", () => handlers.onNext?.());
  if (handlers.onSeekBackward) {
    set("seekbackward", (d) => {
      const offset = (d as { seekOffset?: number } | undefined)?.seekOffset;
      handlers.onSeekBackward?.(offset && offset > 0 ? offset : 10);
    });
  }
  if (handlers.onSeekForward) {
    set("seekforward", (d) => {
      const offset = (d as { seekOffset?: number } | undefined)?.seekOffset;
      handlers.onSeekForward?.(offset && offset > 0 ? offset : 10);
    });
  }
  if (handlers.onSeekTo) {
    set("seekto", (d) => {
      const time = (d as { seekTime?: number } | undefined)?.seekTime;
      if (typeof time === "number") handlers.onSeekTo?.(time);
    });
  }
}

export function clearMediaSession() {
  const ms = session();
  if (!ms) return;
  for (const action of ALL_ACTIONS) {
    try {
      ms.setActionHandler(action, null);
    } catch {
      /* ignore */
    }
  }
  ms.metadata = null;
  ms.playbackState = "none";
}
