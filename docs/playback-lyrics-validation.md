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

## Queue rows — only one song ever looks live

Two things made the queue misleading:

**The next song looked like it was already playing.** Queue slot #1 carried the same visual
language as the deck — an animated `eq-bar` equalizer burned into its thumbnail, a pulsing
`SkipForward` icon in the number column, and a glowing gradient card. At a glance two rows
appeared to be playing at once. The equalizer and every `animate-pulse` are now gone from the
Up Next list; the row keeps a quiet fuchsia tint, a fuchsia `01`, a static **Up next** chip on
the artwork and a **Plays next** pill. Animation is reserved for the one row that really is
playing, so `eq-bar` now appears exactly once in the panel (Now Playing) — a test enforces that.

**The song name disappeared.** The title sat in a `flex items-center gap-1.5` next to a
`shrink-0` badge, so in a 420px column the pill took its width first and the `truncate`d title
was left with a few characters. Three changes give the name the whole row:

| Before | After |
| --- | --- |
| `shrink-0` badge inline with the title | badge on its own line *above* the title |
| single `truncate` line | `line-clamp-2` with `title={...}` for the full name on hover |
| duration in its own column, admin buttons reserving ~120px even while invisible (`lg:opacity-0`) | duration folded into the meta line; buttons use `.row-actions` |

`.row-actions` (in `globals.css`) takes the admin cluster out of flow under
`@media (min-width: 768px) and (hover: hover)` — it floats over the right edge of the row on
hover or keyboard focus, so it costs the title zero width. Touch devices and screens below
`md` never match that query and keep the buttons in flow, where `w-full shrink-0 sm:w-auto`
drops them onto their own line on a phone. Thumbnails went 84px → 76px as well. Net effect in
the narrowest column: the title went from roughly 90px of space to the full row width.

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

---

# Round 6 — secrets, reconnects, soft drift, and the room's colour

## Security and configuration

| Problem found | Fix |
| --- | --- |
| `src/lib/constants.ts` held `process.env.PARTY_PASSWORD ?? "hirashesh"` and an admin equivalent. The module is imported by client components, so **both fallback passwords were bundled into the browser JavaScript** — the repo was the key to the room | `src/lib/env.ts` is server-only and has no defaults. Missing secrets fail closed: a boot-time `console.error`, `authConfigured()` false, and every auth path answers `503 not-configured` with a message naming the missing variables |
| Passwords were compared with `===`, which returns early on the first differing byte | `secretEquals()` hashes both sides with SHA-256 and compares with `timingSafeEqual`. Hashing first keeps the buffers equal-length, so neither the value nor its *length* leaks |
| Nothing stopped a script from trying ten thousand passwords, or flooding chat | `src/lib/rate-limit.ts`: a pure token bucket (`takeToken`) plus a keyed in-memory store. Auth 8 then 1/7.5s, chat 12 then 1/s, reactions 15 then 1.5/s, queue 20 then 1/2s, all per client IP taken from the first `x-forwarded-for` hop. Denials return `429` with `Retry-After` |
| `env.ts` must not throw at import time, or `next build` dies on a machine without secrets | it only logs; the 503 is produced per request |

## Reconnects and hidden tabs

| Problem found | Fix |
| --- | --- |
| A background tab stopped polling entirely, but **YouTube kept playing** — so a phone in a pocket drifted for minutes and snapped on return | hidden tabs poll every 6 s instead of every 1 s (`POLL_MS_HIDDEN`). The loop runs on a Web Worker timer (`src/lib/ticker.ts`) because browsers clamp `setInterval` to once a minute in background pages |
| One dropped poll looked identical to a dead connection | `connectionStatus()` needs two consecutive failures before the "reconnecting" banner appears; `navigator.onLine === false` shows "offline" immediately |
| A flaky link produced a tight retry loop against an already-struggling server | exponential backoff 1 s → 20 s with ±25% jitter (`nextPollDelayMs`), floored at the current visibility's poll interval |
| Coming back from a gap, the deck drifted in slowly from a stale anchor | `shouldForceResyncOnRecovery()` — after ≥2 failures or ≥4 s without a confirmed snapshot, the first good poll triggers a 3-sample clock burst and a hard seek |
| Every poll already carried `serverNow`, and it was thrown away | each poll is now a free RTT sample into the shared clock store, so the anchor stays fresh between bursts and a reconnect re-converges almost immediately |

## One clock for the whole page

`src/lib/clock-store.ts` replaces the per-component sample arrays. It keeps the
twelve most recent samples, anchors on the lowest RTT, drops anything slower
than 4 s, and publishes to subscribers. `seedClockFromServerNow()` gives a fresh
tab a coarse anchor from the first snapshot but refuses to overwrite a measured
one.

## Soft drift correction

A seek is audible; a 3% speed change is not. `planDriftCorrection()` in
`src/lib/playback.ts` is a pure function over `{driftSec, currentRate, strikes,
seekCooledDown, force, rateSupported}`:

- inside the deadband → do nothing;
- outside it → steer at `0.97x` (ahead) or `1.03x` (behind), and *say nothing*
  if the deck is already steering the right way;
- back within `DRIFT_SETTLED_SEC` (0.12 s) → hand the deck back to `1.0x`;
- far out, after two strikes and a cooldown → seek.

`setPlaybackRate` is advisory in the IFrame API: values outside
`getAvailablePlaybackRates()` are ignored, and the bridge is async. The deck
therefore records the rate it asked for and re-reads it ~900 ms later; on a
mismatch it sets `rateSupported = false` and falls back to the seek ladder for
the rest of the session.

## Transport hygiene

`POST /api/player` is now fired through `postJson()` (`src/lib/net.ts`), which
adds an 8 s timeout and a single 700 ms retry — but **only** for the three
idempotent reports (`ended`, `duration`, `unplayable`). Retrying `skip` or
`toggle` would skip two songs or undo the host's own click. `429` is never
retried: backing off is the entire point of the response.

## Features

- **Paste any YouTube link.** `parseYouTubeTarget()` understands `watch`,
  `youtu.be`, `shorts`, `embed`, `music.`, bare 11-character ids and playlist
  URLs, and carries `t=90` / `t=1m30s` / `t=1h2m3s` start offsets through. The
  search route resolves a pasted id via oEmbed (no API key needed) and scrapes
  up to 12 entries from a playlist page.
- **Floating reactions.** Six emoji, stored as `chatMessages.kind = "reaction"`
  so they survive a reload, returned in a 9-second window capped at 24 rows, and
  laid out with golden-ratio lane hashing so a burst of the same emoji does not
  stack in one column. The sender's own reactions are filtered out of the
  snapshot (`r.userId !== me.id`) because they already rendered locally.
- **Media Session.** Lock-screen artwork, title and position. For the host the
  controls drive the room (play, pause, seek, next); for guests play/pause is
  mapped to **local mute**, so a headphone button cannot pause the party for
  everybody else.
- **Per-track theming.** `src/lib/palette.ts` samples the artwork in a 36×36
  canvas, buckets the pixels, discards crushed blacks, blown highlights and grey
  chrome, and weights saturated mid-tones. The winner is normalised to something
  readable on near-black and pushed onto `<html>` as `--vibe-accent`,
  `--vibe-accent-2` and `--vibe-glow`, which `Aurora.tsx` and the room's
  gradients read. A grey thumbnail returns `null` and the house palette stays.
  Note: CSS cannot transition between two `background-image` values, so the
  colour change lands on the next paint rather than crossfading.
- **Keyboard shortcuts** — `space`/`k`, `n`, `←`/`→` (host only), `m`, `/`, `r`.
  Dispatched as `CustomEvent`s through `src/lib/room-events.ts` so the shell can
  talk to the deck without threading props or lifting state.

## React Compiler lint: 12 errors → 0

The round-5 baseline was 12 errors. All are now fixed, and no rule was disabled
to get there.

| Rule | Where | Fix |
| --- | --- | --- |
| `react-hooks/purity` ×2 | `NowPlaying` | `Date.now()` / `performance.now()` ran inside a `useRef` initializer. The clock moved into the shared store, so nothing reads a wall clock during render |
| `react-hooks/refs` ×2 | `PartyShell` | `ref.current = …` during render → mirrored in a `useEffect` instead |
| `react-hooks/set-state-in-effect` ×2 | `PartyShell` | `adminKey` is now a lazy `useState` initializer reading `localStorage` behind a `typeof window` guard; the unread-chat reset became derived state plus an explicit reset in the two buttons that open chat |
| `react-hooks/set-state-in-effect` ×1 | `SearchPanel` | clearing results moved out of the debounce effect into the `onChange` handler, where the user's intent actually is |
| `react-hooks/set-state-in-effect` ×2 | `QueuePanel`, `LyricsOverlay` | **the interesting ones.** Both were `setLoading(true)` at the top of a fetch-on-prop-change effect. Rewritten so the fetch result is stored *together with the request it answers* (`{key, data}`), and `loading` is derived as `result.key !== currentQuery`. No flag, no cascade, and a stale response can no longer overwrite a newer one |
| `react-hooks/set-state-in-effect` ×3 | `NowPlaying`, `QueuePanel` | effects that called `sync()` or rebuilt a memo from a snapshot — deferred to the next macrotask, or rewritten to read the snapshot fields the memo actually depends on |

The two remaining warnings are pre-existing `exhaustive-deps` notes on
intentionally-stable callbacks.

## Repository basics

`.env.example`, `README.md`, MIT `LICENSE`, committed Drizzle migrations in
`drizzle/`, and `.github/workflows/ci.yml` running typecheck → lint → tests →
build on every push and PR.

## Tests

`tests/sync-net-theme.test.cjs` adds 23 tests (53 total, all passing) covering
the clock store's anchor selection and subscriptions, backoff and reconnect
decisions, retry eligibility, every shape of pasted YouTube URL, reaction
validation and lane spread, the token bucket and per-key isolation, fail-closed
auth, HSL round-tripping, dominant-colour extraction, and the drift plan in all
of its branches.

## Not done

Honest list: `NowPlaying.tsx` is still one very large component and was not
split; there are no Playwright or k6 suites; there is no Sentry wiring or
`/api/client-error` route; beat-reactive visuals, Auto-DJ, PWA installability,
chat threading and mood themes remain in the backlog. None of the UI changes in
this round could be verified in a browser from the build environment — there is
no Postgres and no display — so everything above is covered by unit tests over
pure functions and by source assertions, not by a runtime check.
