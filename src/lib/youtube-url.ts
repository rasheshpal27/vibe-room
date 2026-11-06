/**
 * Parse anything a guest might paste into the search box.
 *
 * Search is great for "that song that goes doo doo doo", useless when
 * somebody already has the exact link. Every shape YouTube hands out is
 * accepted here — watch URLs, youtu.be shorteners, Shorts, embeds, live
 * links, music.youtube.com, playlists, or a bare video id.
 */

export type YouTubeTarget =
  | { kind: "video"; videoId: string; listId: string | null; startSec: number }
  | { kind: "playlist"; listId: string };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID_RE = /^[A-Za-z0-9_-]{12,48}$/;

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID_RE.test(value);
}

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds. */
export function parseTimeParam(raw: string | null): number {
  if (!raw) return 0;
  const plain = Number(raw);
  if (Number.isFinite(plain) && plain >= 0) return Math.floor(plain);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return (
    Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  );
}

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * Returns the video or playlist a string points at, or null when it is just
 * an ordinary search phrase.
 */
export function parseYouTubeTarget(input: string): YouTubeTarget | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  // A bare id pasted on its own.
  if (VIDEO_ID_RE.test(raw)) {
    return { kind: "video", videoId: raw, listId: null, startSec: 0 };
  }
  if (/^(PL|OL|UU|LL|RD|FL)[A-Za-z0-9_-]{10,}$/.test(raw)) {
    return { kind: "playlist", listId: raw };
  }

  // Anything with a space is a search phrase, not a link.
  if (/\s/.test(raw)) return null;

  const url = toUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;

  const params = url.searchParams;
  const listParam = params.get("list");
  const listId = listParam && LIST_ID_RE.test(listParam) ? listParam : null;
  const startSec =
    parseTimeParam(params.get("t")) || parseTimeParam(params.get("start"));

  const fromPath = (): string | null => {
    const segments = url.pathname.split("/").filter(Boolean);
    if (!segments.length) return null;
    if (host.endsWith("youtu.be")) {
      return VIDEO_ID_RE.test(segments[0]) ? segments[0] : null;
    }
    const [head, next] = segments;
    if (["shorts", "embed", "live", "v"].includes(head) && next) {
      return VIDEO_ID_RE.test(next) ? next : null;
    }
    return null;
  };

  const vParam = params.get("v");
  const videoId =
    vParam && VIDEO_ID_RE.test(vParam) ? vParam : fromPath();

  if (videoId) return { kind: "video", videoId, listId, startSec };
  if (listId) return { kind: "playlist", listId };
  return null;
}

/** Canonical watch URL — what oEmbed wants. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function playlistUrl(listId: string): string {
  return `https://www.youtube.com/playlist?list=${listId}`;
}
