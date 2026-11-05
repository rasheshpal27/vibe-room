import { NextRequest, NextResponse } from "next/server";
import {
  buildLyricsQueries,
  normalizeArtistName,
  normalizeTrackTitle,
  rankLyricsCandidates,
  type LyricsCandidate,
} from "@/lib/lyrics";

export const dynamic = "force-dynamic";

const PROVIDER = "https://lrclib.net";
/** Whole-request budget so a slow provider can never hang the route. */
const DEADLINE_MS = 7000;
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const cache = new Map<string, { at: number; ranked: LyricsCandidate[] }>();

function toCandidate(raw: unknown): LyricsCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const trackName = typeof r.trackName === "string" ? r.trackName : "";
  if (!trackName) return null;
  return {
    id: typeof r.id === "number" ? r.id : undefined,
    trackName,
    artistName: typeof r.artistName === "string" ? r.artistName : "",
    albumName: typeof r.albumName === "string" ? r.albumName : null,
    duration: typeof r.duration === "number" ? r.duration : null,
    instrumental: r.instrumental === true,
    plainLyrics: typeof r.plainLyrics === "string" ? r.plainLyrics : null,
    syncedLyrics: typeof r.syncedLyrics === "string" ? r.syncedLyrics : null,
  };
}

async function providerFetch(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${PROVIDER}${path}`, {
      signal: AbortSignal.timeout(6500),
      headers: {
        "User-Agent": "vibe-room (https://github.com/rasheshpal27/vibe-room)",
      },
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Find the lyrics for the track that is *actually playing*.
 *
 * Music-video uploads ("… | Full Video | Movie | 4K") used to resolve to a
 * completely different song, so we normalise the title, walk a ladder of
 * provider queries, and rank every candidate by synced-lyrics availability,
 * duration proximity and title/artist similarity.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const title = params.get("title")?.trim();
  const artist = params.get("artist")?.trim() ?? "";
  const durationSec = Math.max(0, Math.round(Number(params.get("duration") ?? 0)) || 0);
  const alt = Math.max(0, Math.min(9, Math.round(Number(params.get("alt") ?? 0)) || 0));

  if (!title || title.length > 300 || artist.length > 300) {
    return NextResponse.json({ error: "Invalid track" }, { status: 400 });
  }

  const target = { title, artist, durationSec };
  const cacheKey = `${title}|${artist}|${durationSec}`.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(shape(hit.ranked, alt, target));
  }

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;
  const queries = buildLyricsQueries(title, artist);
  const collected: LyricsCandidate[] = [];
  let providerReachable = false;

  // 1. Exact get (title + artist + duration) — the cheapest precise hit.
  for (const q of queries.slice(0, 2)) {
    if (outOfTime()) break;
    const search = new URLSearchParams({ track_name: q.track });
    if (q.artist) search.set("artist_name", q.artist);
    if (durationSec > 0) search.set("duration", String(durationSec));
    const data = await providerFetch(`/api/get?${search}`);
    if (data) {
      providerReachable = true;
      const candidate = toCandidate(data);
      if (candidate) collected.push(candidate);
      if (candidate?.syncedLyrics) break;
    }
  }

  // 2. Structured search, then free-text search as a safety net.
  if (!collected.some((c) => c.syncedLyrics)) {
    for (const q of queries.slice(0, 4)) {
      if (outOfTime()) break;
      const search = new URLSearchParams({ track_name: q.track });
      if (q.artist) search.set("artist_name", q.artist);
      const data = await providerFetch(`/api/search?${search}`);
      if (Array.isArray(data)) {
        providerReachable = true;
        for (const row of data.slice(0, 12)) {
          const candidate = toCandidate(row);
          if (candidate) collected.push(candidate);
        }
      }
      if (collected.some((c) => c.syncedLyrics)) break;
    }
  }

  if (!collected.length && !outOfTime()) {
    const free = `${normalizeTrackTitle(title)} ${normalizeArtistName(artist)}`.trim();
    if (free) {
      const data = await providerFetch(`/api/search?q=${encodeURIComponent(free)}`);
      if (Array.isArray(data)) {
        providerReachable = true;
        for (const row of data.slice(0, 12)) {
          const candidate = toCandidate(row);
          if (candidate) collected.push(candidate);
        }
      }
    }
  }

  if (!collected.length) {
    if (!providerReachable) {
      return NextResponse.json(
        { error: "Lyrics provider unavailable" },
        { status: 503 }
      );
    }
    cache.set(cacheKey, { at: Date.now(), ranked: [] });
    return NextResponse.json(shape([], alt, target));
  }

  const ranked = rankLyricsCandidates(collected, target);
  cache.set(cacheKey, { at: Date.now(), ranked });
  if (cache.size > 300) {
    for (const key of [...cache.keys()].slice(0, 60)) cache.delete(key);
  }
  return NextResponse.json(shape(ranked, alt, target));
}

function shape(
  ranked: LyricsCandidate[],
  alt: number,
  target: { title: string; artist: string; durationSec: number }
) {
  if (!ranked.length) {
    return {
      unavailable: true,
      syncedLyrics: null,
      plainLyrics: null,
      instrumental: false,
      alternatives: 0,
      index: 0,
      matched: null,
      query: {
        title: normalizeTrackTitle(target.title),
        artist: normalizeArtistName(target.artist),
      },
    };
  }
  const index = ranked.length ? alt % ranked.length : 0;
  const pick = ranked[index];
  return {
    syncedLyrics: pick.syncedLyrics ?? null,
    plainLyrics: pick.plainLyrics ?? null,
    instrumental: pick.instrumental === true,
    alternatives: ranked.length,
    index,
    matched: {
      trackName: pick.trackName,
      artistName: pick.artistName,
      duration: pick.duration ?? null,
    },
    query: {
      title: normalizeTrackTitle(target.title),
      artist: normalizeArtistName(target.artist),
    },
  };
}
