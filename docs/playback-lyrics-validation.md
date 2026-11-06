# Playback and lyrics validation

Automated: `node --test tests/*.test.cjs`, `npm run typecheck`.

Tests cover:
1. LRC ordering/multiple timestamps and instrumental gaps (`src/lib/lyrics.ts`).
2. Stable YouTube player hosts, cancelled startup, retry creation, and resetting rejected API loads (`src/lib/yt-loader.ts`).
3. World-clock exact millisecond synchronization using multi-sample NTP-style RTT filtering anchored to `performance.now()` (`src/lib/clock.ts`).
4. Contextual & curated song suggestions for the queue (`src/lib/suggestions.ts` & `/api/suggestions`).
5. Equal-power crossfade gains, the early-end-report guard, the two-deck hand-over and the
   end-of-track hold (round 3).
6. Playhead store fan-out, single-advance queue guard, duration self-repair, poll hygiene,
   seek hysteresis, reload-without-a-sound-prompt, host-only controls, PC-first layout and the
   transparent lyrics panel (round 2 audit).
7. Same-page Name + Password entry (`src/components/EntryGate.tsx`) and full Queue History (`status === "done"`) with scroll-up support and "Next playing" icon indicator (`src/components/QueuePanel.tsx`).

## Songs overlap — the music never stops

Two persistent YouTube decks sit stacked in the poster. One owns the room's current track;
the other preloads the next one and then plays the outgoing track's tail while the two
crossfade. Roles swap on every song change, so a hand-over costs no iframe boot and no reload.

The overlap depends on exactly one thing: **the room timeline must move on while the outgoing
deck still has audio left.** Everything else is an optimisation.

| Stage | What happens |
| --- | --- |
| whole party | the second deck is kept alive permanently (booting it on demand is what made a skip sound like a hard cut) |
| ~6s into a track | the next song is preloaded on the idle deck: loaded muted, then parked back at 0 as soon as it is rolling. `cueVideoById` does not fetch media, so starting-then-pausing is the only way to get a primed decoder. Readiness is polled *and* event driven — a single missed state callback used to disable the whole crossfade silently |
| `CROSSFADE_SEC` (4s) left | the first client there reports `ended` **early**, the server promotes the next track, and every guest moves to the new timeline at the same instant. This no longer waits for the preload |
| the switch | decks swap roles. A primed deck just resumes; a cold one loads now. Either way the outgoing deck is never touched, so its tail keeps playing |
| overlap | the ramp waits until the incoming deck is *audibly rolling* (max `FADE_HOLD_MAX_MS`, 1.8s) with the outgoing held at full volume, then runs equal-power `sin`/`cos` gains so there is no loudness dip, with a matching opacity cross-dissolve |
| end of fade | the outgoing deck is stopped, muted and becomes the idle deck for the next song |

Remaining time is `min(room timeline, the player's own clock)` — the room's `durationSec` is only
as good as the search provider's metadata, and when the real video is shorter the room would
never reach the window before the sound stopped. That is what produced a "mixing" badge with no
audible overlap.

**Skips crossfade too.** A skip, a deleted current track or any other unexpected change uses
`SKIP_FADE_MS` (2.5s) instead of the 4s tail, and because the next song is already primed from
6s into the current one, the incoming deck normally starts immediately. If it does not, the
outgoing song simply holds at full volume until it does.

Guards:
* No early switch without something queued behind the current track, while paused, or for clips
  shorter than `MIN_CROSSFADE_TRACK_SEC` (45s).
* A fade never lasts longer than the audio the outgoing deck actually has left, so a mix can
  never end on an abrupt cut.
* Pausing the room, a recovery rebuild or another track change mid-fade stops the tail
  immediately; the sync loop never fights the ramp (`isFading` owns the volume).
* If the outgoing deck has already finished (no early switch happened) there is no fade and no
  "mixing" badge — the hand-over is just instant.
* `shouldAcceptEndReport` (server) rejects an `ended` that arrives more than
  `CROSSFADE_SEC + 4` seconds early, so a stale client cannot cut a song in half. The player's
  own measured duration wins when it is shorter than the stored one — that is the "metadata
  lied" case, which used to stall the room until the watchdog.

## A finished track is never replayed

The old symptom: at the end of a song the first seconds played again two or three times before
the next track arrived. The sync loop saw `party.isPlaying` with the player not in
PLAYING/BUFFERING and called `playVideo()` — and `playVideo()` on an ENDED video restarts it
from zero, which then ended again, in a loop until the server advanced.

Reaching the end now latches `endedHoldRef` for that track. While it is held the deck issues no
play nudge, no corrective seek and no stall rebuild; it simply rests on the last frame until the
room moves on (the hold is released by a track change, or by scrubbing back into the song).
With crossfade enabled the room advances before the video ever reaches its end, so this is the
backstop rather than the normal path.

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

## Sound is on by default — including after a reload

The deck no longer *assumes* a reload needs muting. The player is always created **unmuted**
(unless the listener muted it themselves) and tries to play with sound. Only if the browser
actually refuses — the player is still not PLAYING/BUFFERING `AUTOPLAY_BLOCK_MS` (1.1s) after
the load — does it switch to muted playback, keeping the room in sync, and show the room's own
"Tap for sound" pill. That check runs *before* the recovery ladder, so a blocked autoplay can
never trigger an iframe rebuild, and it is armed only until the page has produced audible
playback once (`audiblePlaybackRef`), so a slow-loading track mid-party never silences anyone.
In practice Chrome/Edge/Firefox let a frequently used room autoplay with sound, so a refresh
is silent-prompt-free; iOS Safari falls back to the pill after ~1.1s.

`src/lib/audio-unlock.ts` still records the document's first gesture (listeners installed in
`src/app/page.tsx`, `EntryGate` marks the join press) and unmutes on the first tap anywhere,
including on the video itself — a transparent catcher covers the iframe, so YouTube's own
unmute overlay is never reachable.

## Lyrics match the version that is playing

Music-video titles ("Kesariya – Full Video | Brahmastra | 4K") used to resolve to a different
song. `normalizeTrackTitle` / `normalizeArtistName` strip publisher noise, `buildLyricsQueries`
walks an exact → structured → free-text ladder against lrclib, and `rankLyricsCandidates` scores
each result on synced-lyrics availability, duration proximity (±2s wins) and title/artist
similarity. The panel shows which track it matched and offers "Wrong?" to cycle alternatives.
YouTube's own subtitles stay off (`cc_load_policy: 0` plus `unloadModule("captions")` on ready,
on `onApiChange`, and after every track load).

## Layout — PC first

Lyrics | Deck | Queue are three real columns from `md` upward, each with its own internal
scroll area, inside a `h-dvh` flex column — the page itself never scrolls. The lyrics column is
the widest it has ever been (`xl:grid-cols-[minmax(380px,1fr)_minmax(460px,1.05fr)_420px]`).

Phones get one full-screen panel at a time, chosen from a five-way bottom bar
(**Deck · Lyrics · Queue · Find · Chat**, Deck first). The deck is never unmounted, never
`display:none`, and never shrunk — mobile browsers throttle hidden or 1×1 iframes and the room
would drift out of sync. When another tab is up it keeps its full size behind it with
`absolute inset-0 opacity-0 pointer-events-none`; on `md` and up those classes are dropped and
it is simply the middle column again.

## Lyrics panel

No card, no border, no backdrop: the words sit straight on the room's aurora
(`maskImage` fades them out at the top and bottom), padding drops to `px-1 sm:px-2` so the text
gets the whole column, the active line is `text-2xl lg:text-3xl` and the rest `text-lg
lg:text-xl`.

## Host-only deck controls

Guests see the artwork, the track meta and a **read-only** progress bar with elapsed/total
times. The volume slider, mute button, play/pause, skip, the scrubber, the millisecond readout,
the UTC resync chip and the admin dock are all behind `isAdmin`. The "Tap for sound" pill stays
visible to everyone — it is the only escape hatch when a browser blocks audio.

## Sync and ping audit

| Problem found | Fix |
| --- | --- |
| Every guest POSTs `ended`; the `currentQueueId` check happened before the row lock, so the second request advanced the queue again and **silently skipped a song** | `advanceQueue(expectedQueueId)` re-checks the id *inside* the locked transaction; `/api/player` passes it for `ended` and `unplayable` |
| `lastSeen` was rewritten on every 1s poll (N writes/second) | heartbeat only fires when the row is older than `HEARTBEAT_MIN_INTERVAL_MS` (20s); the 90s online cutoff is unchanged |
| `getSnapshot` selected *every* `queueItems` row forever | four bounded queries: queued ≤80, history ≤30 (newest, reversed), users ≤100, chat ≤60 |
| A wrong `durationSec` froze the progress bar and made the server cut the song at `duration + 15s` | the deck reports `player.getDuration()` once per track via `POST /api/player {action:"duration"}`; the server validates 20–7200s and only writes when it differs by >2s |
| The 100ms position tick lifted the playhead into shell state → the whole party re-rendered 10×/s | `src/lib/playhead.ts`: the deck publishes, the lyrics subscribe and only `setState` when the highlighted line changes; the shell holds no playhead state |
| 0.25s seek tolerance + 1.2s cooldown re-seeked on measurement noise (audible stutter) | 0.3s tolerance, **two consecutive** breaches required, 2s cooldown; `playVideo()` nudges rate-limited to 900ms |
| Polls overlapped on slow links and kept running in background tabs | one in-flight request at a time, `AbortSignal.timeout(8000)`, paused while `document.hidden`, instant refresh on visibility/focus/online |
| Every poll re-rendered the room even when nothing changed | `renderSignature()` ignores `serverNow`/heartbeat timestamps; identical snapshots skip `setState` entirely. `SearchPanel`/`ChatPanel` are memoised |
| A full-screen film-grain layer animated 4 steps/0.9s forever | the grain is now static, and `prefers-reduced-motion` disables the aurora, spin, pulse and marquee |
| `setUnreadChat` ran inside the `setSnap` updater (impure, double-fires in StrictMode) | unread counting moved out of the updater and is suppressed for the first snapshot |
