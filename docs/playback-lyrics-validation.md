# Playback and lyrics validation

Automated: `node --test tests/*.test.cjs`, `npm run typecheck`.
Tests cover:
1. LRC ordering/multiple timestamps and instrumental gaps (`src/lib/lyrics.ts`).
2. Stable YouTube player hosts, cancelled startup, retry creation, and resetting rejected API loads (`src/lib/yt-loader.ts`).
3. World-clock exact millisecond synchronization using multi-sample NTP-style RTT filtering anchored to `performance.now()` (`src/lib/clock.ts`).
4. Contextual & curated song suggestions for the queue (`src/lib/suggestions.ts` & `/api/suggestions`).
5. Same-page Name + Password entry (`src/components/EntryGate.tsx`), inline Home Page Lyrics enabled by default (`src/components/LyricsOverlay.tsx` & `src/components/NowPlaying.tsx`), and full Queue History (`status === "done"`) with scroll-up support and "Next playing" icon indicator (`src/components/QueuePanel.tsx`).
