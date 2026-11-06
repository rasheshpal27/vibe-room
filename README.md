# vibe-room

A shared YouTube listening room. One host drives a single deck; everyone else's
browser plays the **same second of the same song**, with a synced queue, live
chat, floating reactions and time-aligned lyrics.

It is not screen sharing and it is not a bot in a voice channel — every guest
plays the video locally, and the app's whole job is to keep those players
agreeing with each other to within a fraction of a second.

---

## How the sync works

There is no WebSocket server. The room is a row in Postgres and every client
polls it; the interesting part is what the client does with each reply.

**1. A shared world clock.** `GET /api/time` and every room poll return the
server's UTC time. The client measures each round trip and keeps the twelve
most recent samples, anchoring on the one with the lowest RTT (`src/lib/clock.ts`,
`src/lib/clock-store.ts`). The anchor is stored against `performance.now()`, not
`Date.now()`, so a laptop waking from sleep or an NTP step does not shift the
room. Samples slower than 4 s are discarded — they say more about the network
than the clock.

**2. The deck is a function of the clock.** The room stores "track X started at
UTC timestamp T". Expected position is `worldNow - T`, so a guest who joins
mid-song lands in the right place on the first frame instead of starting at zero
and being yanked forward.

**3. Drift is steered, not slammed.** A seek is audible, so small errors are
corrected with playback rate instead (`planDriftCorrection` in
`src/lib/playback.ts`): more than ~0.3 s out, the deck runs at 0.97x or 1.03x
until it has quietly eaten the difference, then returns to 1.0x. Only a large
gap — or a player that refuses fractional rates — triggers a real seek, and then
only after two consecutive bad samples plus a cooldown.

**4. Track changes crossfade.** The deck runs two YouTube players. The next
track is pre-buffered on the idle deck (muted `loadVideoById`, then paused at
zero), and the handover is an equal-power volume curve, so there is no silent
gap between songs.

**5. Polling adapts.** Visible tabs poll every second, hidden tabs every six —
hidden tabs keep polling because their audio keeps playing. The loop is driven
by a Web Worker timer, since browsers clamp `setInterval` in background pages.
Two consecutive failures show a "reconnecting" banner and start an exponential
backoff with jitter; the first successful poll after a gap triggers a clock
burst and a hard re-anchor (`src/lib/connection.ts`).

**6. Polls stay cheap.** Responses are ETagged — an unchanged room returns 304.
Chat is fetched incrementally by `?chatSince=<id>`, the snapshot carries a
signature so an identical payload never re-renders the room, and the playhead is
published through a tiny external store so a ticking timecode doesn't re-render
the chat panel.

---

## Features

- **Synced playback** with crossfade, soft drift correction and automatic
  recovery from stalled or unplayable videos.
- **Shared queue** — search YouTube, or paste any `youtube.com` / `youtu.be` /
  Shorts / Music / playlist link (timestamps like `?t=1m30s` are honoured).
- **Host controls** — play/pause, skip, seek, reorder, remove, clear, lock the
  room. Guests can add to the queue but never hijack the deck.
- **Live chat** with GIFs and system messages, plus **floating emoji reactions**
  that drift up the screen for everyone at once.
- **Time-aligned lyrics** from LRCLIB, auto-scrolled to the current line, with
  alternate-version switching when the first match is wrong.
- **Per-track theming** — the dominant colour of the album art is sampled in a
  canvas and pushed onto the page as CSS custom properties, so the whole room
  takes on the colour of whatever is playing.
- **Media Session integration** — lock-screen and headphone controls. For the
  host they drive the room; for guests play/pause maps to local mute, so a
  hardware button can never pause the party for everyone else.
- **Keyboard shortcuts** — `space`/`k` play-pause and `n` skip and `←`/`→`
  seek 5 s (host only), `m` mute locally, `/` jump to search, `r` force a
  resync.
- Works on phones, including the iOS autoplay dance (first tap unlocks audio).

---

## Quick start

```bash
git clone https://github.com/rasheshpal27/vibe-room.git
cd vibe-room
npm install

cp .env.example .env.local     # then fill in the three required values
npm run db:migrate             # create the tables
npm run dev                    # http://localhost:3000
```

### Configuration

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (Neon, Supabase, Railway, local…). |
| `PARTY_PASSWORD` | yes | The code guests type to get in. |
| `ADMIN_PASSWORD` | yes | Unlocks host mode: transport, reordering, skipping. |
| `YOUTUBE_API_KEY` | no | Data API v3 key. Without it, search falls back to public Piped/Invidious instances — slower and flakier, but working. |

There are **no default passwords**. If `PARTY_PASSWORD` or `ADMIN_PASSWORD` is
missing the app logs a config error at boot and every auth route answers `503
not-configured`: nobody can join and nobody can claim host. Failing closed is
deliberate — an earlier version shipped fallback literals that were bundled into
the client JavaScript.

Both passwords are compared with `timingSafeEqual` over SHA-256 digests, so
neither the value nor its length leaks through response timing. Auth, chat,
reactions and queue writes are all behind per-IP token buckets
(`src/lib/rate-limit.ts`).

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next dev server. |
| `npm run build` / `npm start` | Production build and serve. |
| `npm run lint` | ESLint, including the React Compiler rules. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | `node --test tests/*.test.cjs` — 53 unit tests, no build step. |
| `npm run db:generate` | Regenerate SQL migrations from `src/db/schema.ts`. |
| `npm run db:migrate` | Apply committed migrations in `drizzle/`. |

Tests transpile the TypeScript sources in memory and run them in a VM with
stubbed globals, so the sync maths, rate limiting, URL parsing, palette
extraction and secret handling are all covered without a browser or a database.
CI runs typecheck → lint → tests → build on every push and pull request.

---

## Layout

```
src/
  app/
    api/
      auth/      join the room, claim host         state/   the room snapshot (ETag + chat delta)
      player/    transport: play, pause, seek…     queue/   add, remove, reorder, clear
      chat/      messages and reactions            search/  YouTube search + pasted links
      lyrics/    LRCLIB proxy with caching         time/    world-clock endpoint
      health/    config and database check         suggestions/ contextual picks
      admin/     end the party, wipe the room
    page.tsx     entry gate -> party shell
  components/
    PartyShell   room shell: polling, connection state, theming, shortcuts
    NowPlaying   the two-deck player, clock sync, drift steering, Media Session
    QueuePanel   queue, history, suggestions       SearchPanel  search and paste
    ChatPanel    chat and reactions                LyricsOverlay  synced lyrics
    FloatingReactions, Aurora, EntryGate
  lib/
    clock, clock-store, playback, playhead, connection, ticker, net,
    party, youtube, youtube-url, lyrics, palette, reactions, media-session,
    room-events, rate-limit, env, types
  db/schema.ts   users, party_state, queue_items, chat_messages
```

## Deployment

Any Node host works; the repo ships a `netlify.toml`. Set the environment
variables above, point `DATABASE_URL` at a pooled connection string, and run
`npm run db:migrate` once against the production database.

`GET /api/health` reports configuration and database status without leaking
secrets — useful as an uptime check.

## Licence

MIT © Rashesh Pal — see [LICENSE](./LICENSE).
