import { SUGGESTED_SONGS } from "./constants";
import type { SongResult } from "./types";

/**
 * Filter and rank suggested songs for the queue, excluding tracks that are
 * already playing or queued, and prioritizing artist/vibe matches when
 * available.
 */
export function buildSongSuggestions(
  candidates: SongResult[],
  excludeVideoIds: Iterable<string>,
  limit = 6
): SongResult[] {
  const excluded = new Set<string>(excludeVideoIds);
  const seen = new Set<string>();
  const out: SongResult[] = [];

  const pool = [...candidates, ...SUGGESTED_SONGS];
  for (const song of pool) {
    if (!song?.videoId) continue;
    if (excluded.has(song.videoId) || seen.has(song.videoId)) continue;
    seen.add(song.videoId);
    out.push(song);
    if (out.length >= limit) break;
  }
  return out;
}
