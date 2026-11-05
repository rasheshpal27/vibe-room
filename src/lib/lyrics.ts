/** One timestamped line of an LRC file. */
export type LyricLine = { time: number; text: string };

export function parseLyrics(lrc: string): LyricLine[] {
  return lrc.split(/\r?\n/).flatMap((line) => {
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    return [...line.matchAll(/\[(\d+):(\d{2}(?:\.\d+)?)\]/g)].map((match) => ({
      time: Number(match[1]) * 60 + Number(match[2]), text,
    }));
  }).sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------------ *
 * Track matching
 *
 * YouTube titles for music videos are noisy ("Kesariya – Full Video |
 * Brahmastra | Arijit Singh (Official 4K Video)"), which makes a naive
 * lyrics lookup return a *different* song. These helpers normalise the
 * title/artist, build a ladder of queries, and score provider results so
 * the panel always lands on the version that is actually playing.
 * ------------------------------------------------------------------ */

export interface LyricsCandidate {
  id?: number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  duration?: number | null;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LyricsTarget {
  title: string;
  artist: string;
  durationSec?: number;
}

/** Decorations publishers staple onto music-video titles. */
const NOISE_PATTERNS: RegExp[] = [
  /\b(official|offcial)\s*(hd\s*)?(music\s*)?(video|audio|song|trailer|teaser|visuali[sz]er)\b/gi,
  /\b(full\s*(video|audio|song|movie)?\s*(song|video)?)\b/gi,
  /\blyric(al|s)?\s*(video|song)?\b/gi,
  /\b(with\s*)?lyrics\b/gi,
  /\b(hd|hq|4k|8k|1080p?|720p?|remaster(ed)?(\s*\d{4})?|re-?master)\b/gi,
  /\b(audio|video)\s*song\b/gi,
  /\b(color|colour)\s*coded\b/gi,
  /\b(slowed|reverb(ed)?|sped\s*up|nightcore|8d\s*audio|bass\s*boosted)\b/gi,
  /\b(cover|karaoke|instrumental\s*version|unplugged)\b/gi,
  /\b(out\s*now|exclusive|premiere|new\s*song|latest)\b/gi,
  /\bvevo\b/gi,
  /\bextended\s*(mix|version)\b/gi,
  /\b(prod\.?\s*by\s*[^|\-–—]*)/gi,
];

/** Featured-artist markers we strip from the *title*. */
const FEAT_IN_TITLE =
  /\s*[\(\[]?\s*(feat\.?|ft\.?|featuring|with)\s+[^)\]|]+[\)\]]?\s*/gi;

const FROM_MOVIE = /\s*[\(\[]?\s*from\s+["“'][^"”']+["”'][\)\]]?\s*/gi;

function stripEmoji(value: string) {
  // Keep it ES2017-safe (no unicode property escapes needed at runtime).
  return value.replace(
    /[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u200D]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g,
    " "
  );
}

/** Words that, alone inside brackets, never belong to the song name. */
const BRACKET_NOISE_WORD =
  /^(?:official|offcial|video|audio|song|music|mv|hd|hq|4k|8k|1080p?|720p?|lyric|lyrics|lyrical|full|visuali[sz]er|teaser|trailer|promo|explicit|clean|remaster|remastered|version|colou?r|coded|new|out|now|with|the|from|and|&|\d{4})$/i;

/** Drop bracketed chunks that contain nothing but publisher noise. */
function dropNoiseBrackets(value: string): string {
  let prev: string;
  let out = value;
  do {
    prev = out;
    out = out.replace(/[\(\[]([^()\[\]]*)[\)\]]/g, (match, inner: string) => {
      const tokens = inner.split(/[\s\-–—,.:|/]+/).filter(Boolean);
      if (!tokens.length) return " ";
      return tokens.every((t) => BRACKET_NOISE_WORD.test(t)) ? " " : match;
    });
  } while (out !== prev);
  return out;
}

/**
 * Turn a messy YouTube video title into the plain song name.
 * "Kesariya – Full Video | Brahmastra | Arijit Singh" -> "Kesariya"
 */
export function normalizeTrackTitle(raw: string): string {
  if (!raw) return "";
  let out = stripEmoji(raw)
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  // Pipe-separated titles put the song first: keep the first meaningful chunk.
  if (out.includes("|")) {
    const head = out.split("|")[0]?.trim();
    if (head && head.length >= 2) out = head;
  }

  out = out.replace(FROM_MOVIE, " ").replace(FEAT_IN_TITLE, " ");
  out = dropNoiseBrackets(out);

  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, " ");

  // Brackets can turn into pure noise only after the patterns above ran.
  out = dropNoiseBrackets(out)
    .replace(/\(\s*[-\u2013\u2014,.]*\s*\)/g, " ")
    .replace(/\[\s*[-\u2013\u2014,.]*\s*\]/g, " ")
    .replace(/\{\s*\}/g, " ");

  // "Artist - Song" -> "Song" is handled by the caller (splitArtist); here we
  // only clean leftover separators and whitespace.
  out = out
    .replace(/\s*[-\u2013\u2014:|]\s*$/g, "")
    .replace(/^\s*[-\u2013\u2014:|]\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return out;
}

/** Normalise a channel/artist string into a plain artist name. */
export function normalizeArtistName(raw: string): string {
  if (!raw) return "";
  let out = stripEmoji(raw)
    .replace(/&amp;/g, "&")
    .replace(/\s*-\s*topic\s*$/i, "")
    .replace(/vevo\b/gi, "")
    .replace(/\b(official|music|records|entertainment|tv|channel|studios?)\b/gi, " ")
    .replace(/[|•]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Keep only the lead artist — providers index songs under one name.
  const lead = out.split(/\s*(?:,|&|\bx\b|\bft\.?\b|\bfeat\.?\b|\band\b)\s*/i)[0];
  if (lead && lead.trim().length >= 2) out = lead.trim();
  return out;
}

function tokenize(value: string): string[] {
  return stripEmoji(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** 0..1 similarity between two free-text strings (token overlap). */
export function textSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hits = 0;
  for (const token of new Set(ta)) if (setB.has(token)) hits++;
  return hits / Math.max(new Set(ta).size, setB.size);
}

/**
 * Query ladder for the lyrics provider, best/most specific first.
 * Deduplicated and free of empty entries.
 */
export function buildLyricsQueries(
  title: string,
  artist: string
): { track: string; artist: string }[] {
  const cleanTitle = normalizeTrackTitle(title);
  const cleanArtist = normalizeArtistName(artist);
  const bare = cleanTitle
    .replace(/\s*[\(\[][^)\]]*[\)\]]\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const dashSplit = cleanTitle.includes(" - ")
    ? cleanTitle.split(" - ").slice(1).join(" - ").trim()
    : "";

  const out: { track: string; artist: string }[] = [];
  const push = (track: string, artistName: string) => {
    const t = track.trim();
    if (!t) return;
    const key = `${t.toLowerCase()}::${artistName.trim().toLowerCase()}`;
    if (out.some((q) => `${q.track.toLowerCase()}::${q.artist.toLowerCase()}` === key)) {
      return;
    }
    out.push({ track: t, artist: artistName.trim() });
  };

  push(cleanTitle, cleanArtist);
  if (bare !== cleanTitle) push(bare, cleanArtist);
  if (dashSplit) push(dashSplit, cleanArtist);
  push(cleanTitle, "");
  if (bare !== cleanTitle) push(bare, "");
  if (title.trim() && title.trim() !== cleanTitle) push(title.trim(), "");
  return out;
}

/**
 * Score a provider result against the track that is actually playing.
 * Higher is better; negative means "almost certainly a different song".
 */
export function scoreLyricsCandidate(
  candidate: LyricsCandidate,
  target: LyricsTarget
): number {
  let score = 0;

  if (candidate.syncedLyrics && candidate.syncedLyrics.trim()) score += 55;
  else if (candidate.plainLyrics && candidate.plainLyrics.trim()) score += 12;
  else if (!candidate.instrumental) score -= 20;

  if (candidate.instrumental) score -= 12;

  const wantTitle = normalizeTrackTitle(target.title);
  const wantArtist = normalizeArtistName(target.artist);

  const titleSim = textSimilarity(wantTitle, candidate.trackName ?? "");
  score += titleSim * 45;
  if (
    wantTitle &&
    candidate.trackName &&
    wantTitle.toLowerCase() === candidate.trackName.trim().toLowerCase()
  ) {
    score += 18;
  }
  if (titleSim === 0) score -= 25;

  if (wantArtist) {
    const artistSim = textSimilarity(wantArtist, candidate.artistName ?? "");
    score += artistSim * 28;
  }

  const want = target.durationSec ?? 0;
  const got = candidate.duration ?? 0;
  if (want > 0 && got > 0) {
    const diff = Math.abs(want - got);
    if (diff <= 2) score += 45;
    else if (diff <= 5) score += 32;
    else if (diff <= 10) score += 18;
    else if (diff <= 20) score += 4;
    else if (diff <= 45) score -= 18;
    else score -= 45;
  }

  return Math.round(score * 100) / 100;
}

/** Rank candidates best-first and drop the obvious mismatches. */
export function rankLyricsCandidates(
  candidates: LyricsCandidate[],
  target: LyricsTarget
): LyricsCandidate[] {
  const seen = new Set<string>();
  const scored = candidates
    .filter((c) => {
      if (!c || (!c.syncedLyrics && !c.plainLyrics && !c.instrumental)) return false;
      const key =
        c.id != null
          ? `id:${c.id}`
          : `${(c.trackName ?? "").toLowerCase()}::${(c.artistName ?? "").toLowerCase()}::${c.duration ?? 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate) => ({
      candidate,
      score: scoreLyricsCandidate(candidate, target),
    }))
    .sort((a, b) => b.score - a.score);

  const keep = scored.filter((s) => s.score > 0);
  return (keep.length ? keep : scored.slice(0, 1)).map((s) => s.candidate);
}
