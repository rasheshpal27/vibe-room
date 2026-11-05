# Playback and lyrics validation

Automated: `node --test tests/*.test.cjs`, `npm run typecheck`.

Tests cover:
1. LRC ordering/multiple timestamps and instrumental gaps (`src/lib/lyrics.ts`).
2. Stable YouTube player hosts, cancelled startup, retry creation, and resetting rejected API loads (`src/lib/yt-loader.ts`).
3. World-clock exact millisecond synchronization using multi-sample NTP-style RTT filtering anchored to `performance.now()` (`src/lib/clock.ts`).
4. Contextual & curated song suggestions for the queue (`src/lib/suggestions.ts` & `/api/suggestions`).
5. Same-page Name + Password entry (`src/components/EntryGate.tsx`) and full Queue History (`status === "done"`) with scroll-up support and "Next playing" icon indicator (`src/components/QueuePanel.tsx`).

## Song changes heal themselves (no page refresh)

`src/lib/playback.ts` holds the policy, `src/components/NowPlaying.tsx` applies it:

| Symptom | Automatic response |
| --- | --- |
| YouTube error 2 / 5 / unknown | `reload` → `rebuild` → `rebuild-muted` → background `rebuild` every 8s |
| YouTube error 100 / 101 / 150 (video cannot be embedded) | retry once, then `POST /api/player {action:"unplayable"}` so the whole room skips the track |
| `loadVideoById` silently never starts (still showing the previous `video_id`) | re-issue the load after a 2.6s grace, then rebuild the iframe |
| Player sits UNSTARTED/CUED/PAUSED while the room is playing | stall detector heals after 3.5s |
| Iframe detached, bridge throws, creation race | in-place rebuild (same effect as a refresh, without one) |
| Browser blocks autoplay-with-sound | fall back to muted playback so the room stays in sync, unmute on the first gesture |

Errors reported for a track the deck already moved past are ignored, `ended` is reported once
per queue item, and the recovery card only appears after the automatic ladder has been
exhausted — it keeps retrying in the background while it is visible.

## Sound is on by default

`src/lib/audio-unlock.ts` records the document's first user gesture (listeners are installed in
`src/app/page.tsx` before anything is clickable, and `EntryGate` marks the join press). When the
document already has activation — the normal join flow — the player is created unmuted and
plays with sound immediately. After a cold reload with no gesture it starts muted and in sync,
shows the room's own "Tap for sound" pill, and unmutes on the first tap anywhere, including on
the video itself (a transparent catcher covers the iframe, so YouTube's own unmute overlay is
never reachable).

## Lyrics match the version that is playing

Music-video titles ("Kesariya – Full Video | Brahmastra | 4K") used to resolve to a different
song. `normalizeTrackTitle` / `normalizeArtistName` strip publisher noise, `buildLyricsQueries`
walks an exact → structured → free-text ladder against lrclib, and `rankLyricsCandidates` scores
each result on synced-lyrics availability, duration proximity (±2s wins) and title/artist
similarity. The panel shows which track it matched and offers "Wrong?" to cycle alternatives.
YouTube's own subtitles stay off (`cc_load_policy: 0` plus `unloadModule("captions")` on ready,
on `onApiChange`, and after every track load).

## Layout

Lyrics | Deck | Queue are three real columns from `md` upward, each with its own internal
scroll area, inside a `h-dvh` flex column — the page itself never scrolls. On phones the deck
stays pinned and visible (its iframe is never hidden or shrunk, which is what mobile browsers
throttle) and the bottom bar swaps the panel underneath it between Lyrics, Queue, Discover and
Chat.
