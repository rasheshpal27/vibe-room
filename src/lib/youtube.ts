import type { SongResult } from "./types";
import { ytThumb } from "./types";

/**
 * Search strategy:
 *  1. Official YouTube Data API v3 when YOUTUBE_API_KEY is configured.
 *  2. Piped API public instances (key-less YouTube proxy).
 *  3. Invidious public instances as a last resort.
 * Results are normalised into SongResult and lightly cached in-memory.
 */

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.private.coffee",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.leptons.xyz",
];

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://iv.melmac.space",
];

const cache = new Map<string, { at: number; data: SongResult[] }>();
const CACHE_TTL = 1000 * 60 * 8;

export function cleanTitle(raw: string) {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s*[\(\[]?(official\s*(music\s*)?(video|audio)|lyric(al)?\s*video|video\s*song|full\s*video|4k|hd)[\)\]]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function splitArtist(title: string, fallback: string) {
  const parts = title.split(" - ");
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { artist: fallback, title: title.trim() };
}

function dedupeAndFinish(items: SongResult[]): SongResult[] {
  const seen = new Set<string>();
  const out: SongResult[] = [];
  for (const it of items) {
    if (!it.videoId || seen.has(it.videoId)) continue;
    // skip snippets and very long streams; allow songs + mood mixes up to 25 min
    if (it.durationSec > 0 && (it.durationSec < 45 || it.durationSec > 1500)) continue;
    seen.add(it.videoId);
    out.push(it);
    if (out.length >= 14) break;
  }
  return out;
}

async function fetchWithTimeout(url: string, ms = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "vibe-party/1.0" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Race a promise against a hard deadline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function searchOfficial(q: string): Promise<SongResult[]> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("no key");
  const url =
    "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video" +
    `&videoCategoryId=10&maxResults=14&q=${encodeURIComponent(q)}&key=${key}`;
  const data = await fetchWithTimeout(url);
  const ids = (data.items ?? [])
    .map((i: any) => i.id?.videoId)
    .filter(Boolean)
    .join(",");
  let durations = new Map<string, number>();
  if (ids) {
    const det = await fetchWithTimeout(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${key}`
    );
    for (const v of det.items ?? []) {
      const iso: string = v.contentDetails?.duration ?? "";
      const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (m) {
        durations.set(
          v.id,
          (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0)
        );
      }
    }
  }
  return (data.items ?? []).map((i: any) => {
    const t = cleanTitle(i.snippet?.title ?? "");
    const { artist, title } = splitArtist(t, i.snippet?.channelTitle ?? "");
    return {
      videoId: i.id.videoId,
      title,
      artist: artist.replace(/ - Topic$/, ""),
      thumbnail: ytThumb(i.id.videoId),
      durationSec: durations.get(i.id.videoId) ?? 0,
    };
  });
}

async function pipedQuery(q: string, filter: string): Promise<SongResult[]> {
  let lastErr: unknown = null;
  for (const base of PIPED_INSTANCES) {
    try {
      const data = await fetchWithTimeout(
        `${base}/search?q=${encodeURIComponent(q)}&filter=${filter}`,
        3500
      );
      const items: any[] = data?.items ?? [];
      const out = items
        .filter((i) => i.type !== "channel" && i.url?.includes("watch?v="))
        .map((i) => {
          const videoId = new URLSearchParams(i.url.split("?")[1]).get("v") ?? "";
          const t = cleanTitle(i.title ?? "");
          const { artist, title } = splitArtist(t, i.uploaderName ?? "");
          return {
            videoId,
            title,
            artist: artist.replace(/ - Topic$/, ""),
            thumbnail: ytThumb(videoId),
            durationSec: Number(i.duration ?? 0),
          };
        });
      if (out.length) return out;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

/**
 * Piped exposes YouTube Music search via `filter=music_songs` — individual
 * tracks with real artist metadata. That is our primary source; the generic
 * videos filter is the fallback (useful for mixes & non-music queries).
 */
async function searchPiped(q: string): Promise<SongResult[]> {
  const songs = await pipedQuery(q, "music_songs");
  if (songs.length) return songs;
  return pipedQuery(q, "videos");
}

async function searchInvidious(q: string): Promise<SongResult[]> {
  let lastErr: unknown = null;
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const data = await fetchWithTimeout(
        `${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&page=1`,
        3500
      );
      const items: any[] = Array.isArray(data) ? data : [];
      const out = items
        .filter((i) => i.type === "video" && i.videoId)
        .map((i) => {
          const t = cleanTitle(i.title ?? "");
          const { artist, title } = splitArtist(t, i.author ?? "");
          return {
            videoId: i.videoId,
            title,
            artist: artist.replace(/ - Topic$/, ""),
            thumbnail: ytThumb(i.videoId),
            durationSec: Number(i.lengthSeconds ?? 0),
          };
        });
      if (out.length) return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("invidious failed");
}

export async function searchSongs(q: string): Promise<SongResult[]> {
  const key = q.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  // Run every strategy in parallel and take the first one that returns
  // results — far snappier than the old sequential fallback chain.
  const strategies = [searchOfficial, searchPiped, searchInvidious];
  const attempts = strategies.map(async (strat) => {
    const finished = dedupeAndFinish(await strat(q));
    if (!finished.length) throw new Error("no results");
    return finished;
  });

  let results: SongResult[] = [];
  try {
    const any = Promise.any(attempts);
    any.catch(() => undefined); // swallow late rejections past the deadline
    results = await withTimeout(any, 5000);
  } catch {
    results = [];
  }
  cache.set(key, { at: Date.now(), data: results });
  return results;
}

/* ------------------------------------------------------------------ *
 * Pasted links
 *
 * Search is useless when somebody already has the exact URL. oEmbed
 * resolves a video id to a real title/author with no API key and no
 * quota; duration is not part of oEmbed, so it comes back as 0 and the
 * deck's existing duration self-repair fixes it a few seconds into
 * playback. Playlists are read from the public watch page, which still
 * embeds its data as JSON.
 * ------------------------------------------------------------------ */

/** Resolve one video id into a queueable song via YouTube's oEmbed endpoint. */
export async function resolveVideoId(videoId: string): Promise<SongResult | null> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;

  try {
    const data = (await fetchWithTimeout(oembed, 6000)) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    const rawTitle = String(data.title ?? "").trim();
    if (!rawTitle) return null;
    const author = String(data.author_name ?? "").replace(/\s*-\s*Topic$/i, "");
    const cleaned = cleanTitle(rawTitle);
    const { artist, title } = splitArtist(cleaned, author || "YouTube");
    return {
      videoId,
      title: title || cleaned || rawTitle,
      artist,
      // oEmbed hands back an hqdefault URL; keep our canonical one.
      thumbnail: ytThumb(videoId),
      durationSec: 0,
    };
  } catch {
    // Unlisted/age-gated videos have no oEmbed entry. They may still play,
    // so offer the raw id rather than refusing the paste.
    return {
      videoId,
      title: `YouTube video ${videoId}`,
      artist: "Pasted link",
      thumbnail: ytThumb(videoId),
      durationSec: 0,
    };
  }
}

const PLAYLIST_ID_RE = /"videoId":"([A-Za-z0-9_-]{11})"/g;

/** Pull the first video ids out of a public playlist page. */
export async function resolvePlaylist(
  listId: string,
  max = 12
): Promise<SongResult[]> {
  if (!/^[A-Za-z0-9_-]{12,48}$/.test(listId)) return [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  let html = "";
  try {
    const res = await fetch(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`,
      {
        signal: ctl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(PLAYLIST_ID_RE)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= max) break;
  }
  if (!ids.length) return [];

  const resolved = await Promise.all(ids.map((id) => resolveVideoId(id)));
  return resolved.filter((r): r is SongResult => r !== null);
}
