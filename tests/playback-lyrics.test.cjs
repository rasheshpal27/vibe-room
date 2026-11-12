const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function transpileTs(code, filename = 'module.ts') {
  try {
    const ts = require('typescript');
    return ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
  } catch {
    const babel = require('/usr/share/nodejs/@babel/core');
    return babel.transformSync(code, {
      filename,
      presets: [
        '/usr/share/nodejs/@babel/preset-typescript',
        ...(filename.endsWith('.tsx') ? ['/usr/share/nodejs/@babel/preset-react'] : []),
      ],
      plugins: ['/usr/share/nodejs/@babel/plugin-transform-modules-commonjs'],
    }).code;
  }
}

function load(filePath, globals = {}) {
  const exports = {};
  const moduleObj = { exports };
  const dir = path.dirname(path.resolve(filePath));
  const customRequire = (id) => {
    if (id.startsWith('.')) {
      const resolved = path.resolve(dir, id + (id.endsWith('.ts') ? '' : '.ts'));
      if (fs.existsSync(resolved)) return load(resolved, globals);
    }
    return require(id);
  };
  const compiled = transpileTs(fs.readFileSync(filePath, 'utf8'), filePath);
  vm.runInNewContext(compiled, {
    exports,
    module: moduleObj,
    require: customRequire,
    ...globals,
  });
  return moduleObj.exports;
}

test('LRC timestamps sort, repeat, and preserve instrumental gaps', () => {
  const { parseLyrics } = load('src/lib/lyrics.ts');
  const lines = parseLyrics('[ar:Artist]\n[00:12.50][00:32.500]Chorus\n[00:01.00]Intro\n[00:20.00]\nplain text');
  assert.equal(JSON.stringify(lines), JSON.stringify([
    {time: 1, text: 'Intro'}, {time: 12.5, text: 'Chorus'}, {time: 20, text: ''}, {time: 32.5, text: 'Chorus'},
  ]));
});

test('player keeps the host intact, cancels stale startup, and can retry', async () => {
  let options, target, destroyed = 0;
  const window = { setTimeout, clearTimeout, location: { origin: 'https://preview.example' }, YT: {
    Player: function(el, opts) { target = el; options = opts; this.destroy = () => destroyed++; },
  }};
  const host = { isConnected: true, replaceChildren(el) { this.child = el; } };
  const { createPlayer } = load('src/lib/yt-loader.ts', {
    window, document: { createElement: () => ({ remove() {} }) },
  });
  const controller = new AbortController();
  let ready = 0;
  const handlers = { onReady() { ready++; }, onStateChange() {} };
  const pending = createPlayer(host, handlers, controller.signal);
  await Promise.resolve();
  assert.notEqual(target, host);
  assert.equal(target, host.child);
  const stale = options.events.onReady;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  stale();
  assert.equal(ready, 0);
  assert.equal(destroyed, 1);
  const retry = createPlayer(host, handlers);
  await Promise.resolve();
  options.events.onReady();
  await retry;
  assert.equal(ready, 1);
});

test('failed API script loads are not cached forever', async () => {
  let script;
  const document = {
    querySelector: () => script,
    createElement: () => ({ addEventListener(_, fn) { this.fail = fn; }, removeEventListener() {}, remove() { script = null; } }),
    head: { appendChild(el) { script = el; } },
  };
  const { loadYouTubeAPI } = load('src/lib/yt-loader.ts', {
    document, window: { setTimeout, clearTimeout, setInterval, clearInterval }, clearInterval, clearTimeout,
  });
  const first = loadYouTubeAPI();
  script.fail();
  await assert.rejects(first, /download/);
  const second = loadYouTubeAPI();
  assert.notEqual(first, second);
  assert.ok(script);
  script.fail();
  await assert.rejects(second, /download/);
});

test('world clock NTP filter selects lowest-RTT samples and computes exact millisecond position', () => {
  const {
    createClockSample,
    selectBestClockAnchor,
    getWorldNowMs,
    computeExpectedPosition,
  } = load('src/lib/clock.ts');

  const s1 = createClockSample(100, 120, 1_700_000_000_110);
  const s2 = createClockSample(200, 224, 1_700_000_000_212);
  const noisy = createClockSample(300, 650, 1_700_000_000_600);

  const state = selectBestClockAnchor([s1, s2, noisy], 1_700_000_000_500, 500);
  assert.equal(state.synced, true);
  assert.equal(state.bestRttMs, 20);
  assert.equal(Math.round(state.utcAtMonoZero), 1_700_000_000_000);

  const worldNow = getWorldNowMs(state, 1_700_000_001_000, 1250);
  assert.equal(Math.round(worldNow), 1_700_000_001_250);

  const pos = computeExpectedPosition(
    {
      isPlaying: true,
      positionSec: 10.5,
      durationSec: 200,
      updatedAtMs: 1_700_000_000_000,
    },
    worldNow
  );
  assert.equal(Math.round(pos.positionMs), 11750);
  assert.equal(pos.positionSec, 11.75);
});

test('song suggestions exclude already queued/playing tracks and fall back to curated list', () => {
  const { buildSongSuggestions } = load('src/lib/suggestions.ts', { process: { env: {} } });
  const custom = [
    { videoId: 'vid-1', title: 'Track 1', artist: 'A', thumbnail: '', durationSec: 180 },
    { videoId: 'vid-2', title: 'Track 2', artist: 'B', thumbnail: '', durationSec: 200 },
  ];
  const res = buildSongSuggestions(custom, ['vid-1'], 5);
  assert.equal(res.length, 5);
  assert.equal(res[0].videoId, 'vid-2');
  assert.ok(!res.some((s) => s.videoId === 'vid-1'));
});

test('track titles from music videos normalise to the real song name', () => {
  const { normalizeTrackTitle, normalizeArtistName, buildLyricsQueries } = load('src/lib/lyrics.ts');

  assert.equal(normalizeTrackTitle('Kesariya – Full Video | Brahmastra | Ranbir Kapoor | Arijit Singh'), 'Kesariya');
  assert.equal(normalizeTrackTitle('Blinding Lights (Official Video)'), 'Blinding Lights');
  assert.equal(normalizeTrackTitle('Shape of You [Official Music Video] 4K'), 'Shape of You');
  assert.equal(normalizeTrackTitle('Levitating (feat. DaBaby) (Official Lyric Video)'), 'Levitating');
  assert.equal(normalizeArtistName('Arijit Singh - Topic'), 'Arijit Singh');
  assert.equal(normalizeArtistName('TaylorSwiftVEVO'), 'TaylorSwift');
  assert.equal(normalizeArtistName('Dua Lipa, Elton John'), 'Dua Lipa');

  const queries = buildLyricsQueries('Kesariya (Official Video) | Brahmastra', 'Arijit Singh - Topic');
  assert.equal(queries[0].track, 'Kesariya');
  assert.equal(queries[0].artist, 'Arijit Singh');
  assert.ok(queries.some((q) => q.artist === ''), 'falls back to a title-only query');
  const seen = new Set(queries.map((q) => `${q.track}::${q.artist}`));
  assert.equal(seen.size, queries.length, 'query ladder has no duplicates');
});

test('lyrics matching prefers synced lyrics for the exact version that is playing', () => {
  const { rankLyricsCandidates, scoreLyricsCandidate } = load('src/lib/lyrics.ts');
  const target = { title: 'Kesariya (Official Video) | Brahmastra', artist: 'Arijit Singh', durationSec: 268 };

  const wrongSong = { trackName: 'Kesariya Balam', artistName: 'Folk Singer', duration: 410, syncedLyrics: '[00:01.00]no' };
  const rightButPlain = { trackName: 'Kesariya', artistName: 'Arijit Singh', duration: 268, plainLyrics: 'plain' };
  const rightSynced = { trackName: 'Kesariya', artistName: 'Arijit Singh', duration: 269, syncedLyrics: '[00:01.00]yes' };
  const longVideoCut = { trackName: 'Kesariya', artistName: 'Arijit Singh', duration: 360, syncedLyrics: '[00:01.00]video cut' };

  const ranked = rankLyricsCandidates([wrongSong, rightButPlain, longVideoCut, rightSynced], target);
  assert.equal(ranked[0], rightSynced, 'closest duration + synced wins');
  assert.ok(scoreLyricsCandidate(rightSynced, target) > scoreLyricsCandidate(longVideoCut, target));
  assert.ok(scoreLyricsCandidate(rightSynced, target) > scoreLyricsCandidate(wrongSong, target));

  // Never return nothing when the provider only has one (imperfect) option.
  assert.equal(rankLyricsCandidates([wrongSong], target).length, 1);
});

test('song-change failures self-heal through an escalating ladder instead of a page refresh', () => {
  const { classifyPlayerError, planRecovery, shouldHealStall, shouldRetryLoad } = load('src/lib/playback.ts');

  assert.equal(classifyPlayerError(150), 'embed-blocked');
  assert.equal(classifyPlayerError(101), 'embed-blocked');
  assert.equal(classifyPlayerError(100), 'missing');
  assert.equal(classifyPlayerError(5), 'transient');

  const transient = [0, 1, 2, 3].map((n) => planRecovery('transient', n));
  assert.deepEqual(transient.map((p) => p.step), ['reload', 'rebuild', 'rebuild-muted', 'rebuild']);
  assert.equal(transient[0].surface, false, 'first retries stay invisible to guests');
  assert.equal(transient[3].surface, true, 'only a stubborn failure surfaces a card');
  assert.ok(transient[3].delayMs >= 8000, 'background retries keep running');

  const blocked = [0, 1, 2].map((n) => planRecovery('embed-blocked', n));
  assert.deepEqual(blocked.map((p) => p.step), ['reload', 'rebuild', 'report-unplayable']);

  // A track that should be playing but sits UNSTARTED gets healed after STALL_GRACE_MS (8s)...
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: -1, msSinceHealthy: 5000, recoveryPending: false }), false, 'slow connection stays inside 8s stall grace');
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: -1, msSinceHealthy: 9000, recoveryPending: false }), true);
  // ...while buffering, an intentional pause, or a pending retry are left alone.
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: 3, msSinceHealthy: 9000, recoveryPending: false }), false);
  assert.equal(shouldHealStall({ shouldPlay: false, playerState: 2, msSinceHealthy: 9000, recoveryPending: false }), false);
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: -1, msSinceHealthy: 9000, recoveryPending: true }), false);
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: -1, msSinceHealthy: 500, recoveryPending: false }), false);

  // The new video never took: still showing the previous id after LOAD_GRACE_MS (7s) -> reload it.
  assert.equal(shouldRetryLoad({ expectedVideoId: 'new', actualVideoId: 'old', playerState: 1, shouldPlay: true, msSinceLoad: 4000 }), false, '4s slow load stays inside 7s grace');
  assert.equal(shouldRetryLoad({ expectedVideoId: 'new', actualVideoId: 'old', playerState: 1, shouldPlay: true, msSinceLoad: 8000 }), true);
  assert.equal(shouldRetryLoad({ expectedVideoId: 'new', actualVideoId: 'new', playerState: 1, shouldPlay: true, msSinceLoad: 8000 }), false);
  assert.equal(shouldRetryLoad({ expectedVideoId: 'new', actualVideoId: 'old', playerState: 1, shouldPlay: true, msSinceLoad: 200 }), false, 'grace period respected');
});

test('audio unlocks automatically from the first gesture anywhere in the app', () => {
  const mod = load('src/lib/audio-unlock.ts', { navigator: undefined });
  const handlers = {};
  const fakeWindow = { addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); } };

  assert.equal(mod.isAudioUnlocked(), false);
  mod.installAudioUnlockListeners(fakeWindow);
  mod.installAudioUnlockListeners(fakeWindow);
  assert.ok(handlers.pointerdown && handlers.pointerdown.length === 1, 'listeners installed exactly once');

  let notified = 0;
  mod.onAudioUnlock(() => notified++);
  handlers.pointerdown[0]();
  assert.equal(mod.isAudioUnlocked(), true);
  assert.equal(notified, 1);
  handlers.keydown[0]();
  assert.equal(notified, 1, 'subscribers fire once');

  // Late subscribers are told immediately.
  let late = 0;
  mod.onAudioUnlock(() => late++);
  assert.equal(late, 1);
});

test('the embed never shows YouTube subtitles or YouTube\'s own unmute overlay', async () => {
  let options;
  const window = { setTimeout, clearTimeout, location: { origin: 'https://preview.example' }, YT: {
    Player: function (el, opts) { options = opts; this.destroy = () => {}; },
  }};
  const host = { isConnected: true, replaceChildren() {} };
  const { createPlayer, disableCaptions } = load('src/lib/yt-loader.ts', {
    window, document: { createElement: () => ({ remove() {} }) },
  });

  const pending = createPlayer(host, { onReady() {}, onStateChange() {} }, undefined, { startMuted: true });
  await Promise.resolve();
  assert.equal(options.playerVars.cc_load_policy, 0, 'captions off at creation');
  assert.equal(options.playerVars.mute, 1, 'can start muted so blocked autoplay still starts in sync');
  assert.equal(options.playerVars.playsinline, 1);
  assert.ok(typeof options.events.onApiChange === 'function', 'captions are re-disabled when modules load');
  options.events.onReady();
  await pending;

  const unloaded = [];
  disableCaptions({ unloadModule: (m) => unloaded.push(m), setOption: () => { throw new Error('nope'); } });
  assert.deepEqual(unloaded, ['captions', 'cc']);
});

test('UI keeps lyrics, deck and queue side by side with automatic sound and self-healing', () => {
  const entryCode = fs.readFileSync('src/components/EntryGate.tsx', 'utf8');
  assert.ok(entryCode.includes('id="entry-name"') && entryCode.includes('id="entry-password"'), 'Name and password on same page');
  assert.ok(entryCode.includes('markAudioUnlocked'), 'Joining counts as the gesture that enables sound');

  const nowPlayingCode = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  assert.ok(!nowPlayingCode.includes('swapPlayers'), 'No DOM iframe reparenting on song change');
  assert.ok(nowPlayingCode.includes('rebuildPlayer'), 'Self-healing player recreation on transition errors');
  assert.ok(nowPlayingCode.includes('startRecovery'), 'Errors run the recovery ladder');
  assert.ok(nowPlayingCode.includes('disableCaptions'), 'YouTube captions stay off');
  assert.ok(nowPlayingCode.includes('soundBlocked'), 'Sound prompt only renders when the browser blocks audio');
  assert.ok(nowPlayingCode.includes('isAudioUnlocked'), 'Sound turns itself on as soon as it is allowed');

  const shellCode = fs.readFileSync('src/components/PartyShell.tsx', 'utf8');
  assert.ok(
    shellCode.includes('aria-label="Lyrics"') &&
    shellCode.includes('aria-label="Deck"') &&
    shellCode.includes('aria-label="Queue and room"') &&
    shellCode.includes('h-dvh'),
    'Lyrics, Deck, and Queue are side-by-side with viewport-locked height'
  );
  assert.ok(shellCode.includes('md:order-1') && shellCode.includes('md:order-2') && shellCode.includes('md:order-3'),
    'Columns are ordered Lyrics | Deck | Queue on wide screens');
  assert.ok(!/\bfixed bottom-0\b/.test(shellCode), 'Bottom bar is in flow so nothing overlaps or scrolls');

  const lyricsCode = fs.readFileSync('src/components/LyricsOverlay.tsx', 'utf8');
  assert.ok(!lyricsCode.includes('createPortal') && !lyricsCode.includes('<dialog'), 'Lyrics inline on home page');
  assert.ok(lyricsCode.includes('duration'), 'Duration is sent so the matcher can pick the right version');

  const queueCode = fs.readFileSync('src/components/QueuePanel.tsx', 'utf8');
  assert.ok(queueCode.includes('Plays next') && queueCode.includes('Played earlier') && queueCode.includes('Suggested for the Queue'));

  const playerRoute = fs.readFileSync('src/app/api/player/route.ts', 'utf8');
  assert.ok(playerRoute.includes('"unplayable"'), 'Server can skip a video nobody can embed');
});

/* ------------------------------------------------------------------ *
 * Round 2: sync/ping audit, PC-first layout, transparent lyrics,
 * host-only deck controls, and no sound prompt after a reload.
 * ------------------------------------------------------------------ */

test('playhead store replays the current position and stops on unsubscribe', () => {
  const { setPlayhead, getPlayhead, subscribePlayhead } = load('src/lib/playhead.ts');
  setPlayhead(42.5);
  const seen = [];
  const stop = subscribePlayhead((s) => seen.push(s));
  assert.deepEqual(seen, [42.5], 'subscribing immediately replays the latest position');
  setPlayhead(43);
  setPlayhead(Number.NaN);
  assert.deepEqual(seen, [42.5, 43, 0], 'updates stream through and garbage is clamped to 0');
  stop();
  setPlayhead(99);
  assert.deepEqual(seen, [42.5, 43, 0], 'no updates after unsubscribe');
  assert.equal(getPlayhead(), 99);

  const throwing = subscribePlayhead(() => { throw new Error('bad subscriber'); });
  assert.doesNotThrow(() => setPlayhead(100), 'a broken subscriber never breaks playback');
  throwing();
});

test('simultaneous "ended" reports can only advance the queue once', () => {
  const partyCode = fs.readFileSync('src/lib/party.ts', 'utf8');
  assert.ok(/export async function advanceQueue\(expectedQueueId\?: number \| null\)/.test(partyCode),
    'advanceQueue takes the track the caller believes is playing');
  const body = partyCode.slice(partyCode.indexOf('export async function advanceQueue'));
  const lockAt = body.indexOf(".for(\"update\")");
  const guardAt = body.indexOf('currentQueueId !== expectedQueueId');
  const promoteAt = body.indexOf('status: "done"');
  assert.ok(lockAt > -1 && guardAt > lockAt && promoteAt > guardAt,
    'the guard is re-checked after the row lock, before anything is promoted');

  const playerRoute = fs.readFileSync('src/app/api/player/route.ts', 'utf8');
  const ended = playerRoute.slice(playerRoute.indexOf('action === "ended"'));
  assert.ok(ended.slice(0, 1200).includes('advanceQueue(qid)'),
    'the ended handler forwards the queue id it saw');
});

test('a wrong track duration is repaired instead of cutting the song off', () => {
  const playerRoute = fs.readFileSync('src/app/api/player/route.ts', 'utf8');
  const duration = playerRoute.slice(playerRoute.indexOf('action === "duration"'));
  assert.ok(duration.includes('qid === state.currentQueueId'), 'only the playing track can be corrected');
  assert.ok(duration.includes('seconds >= 20') && duration.includes('seconds <= 7200'),
    'absurd durations are rejected');
  assert.ok(duration.includes('Math.abs(seconds - (state.durationSec ?? 0)) > 2'),
    'no write unless it actually differs (idempotent for every other guest)');

  const nowPlayingCode = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  assert.ok(nowPlayingCode.includes('reportedDurationRef'), 'each client reports at most once per track');
  assert.ok(nowPlayingCode.includes('"duration"'), 'the real player duration is sent back to the room');
});

test('the room poll is quiet: bounded payload, throttled heartbeat, no overlap, paused when hidden', () => {
  const partyCode = fs.readFileSync('src/lib/party.ts', 'utf8');
  assert.ok(partyCode.includes('HEARTBEAT_MIN_INTERVAL_MS') && partyCode.includes('lt(users.lastSeen'),
    'lastSeen is only written when it is stale, not on every poll');
  assert.ok(partyCode.includes('.limit(MAX_QUEUE_ROWS)') && partyCode.includes('.limit(MAX_HISTORY_ROWS)') &&
    partyCode.includes('.limit(MAX_CHAT_ROWS)'), 'an all-night party cannot grow the poll payload');

  const shellCode = fs.readFileSync('src/components/PartyShell.tsx', 'utf8');
  assert.ok(shellCode.includes('inFlightRef'), 'one state request at a time');
  assert.ok(shellCode.includes('AbortSignal.timeout(POLL_TIMEOUT_MS)'), 'a hung poll cannot wedge the loop');
  assert.ok(shellCode.includes('nextPollDelayMs') && shellCode.includes('hidden: isHidden()'),
    'a background tab polls slowly rather than stopping: the audio keeps playing');
  assert.ok(shellCode.includes('createTicker'),
    'the poll loop runs on a worker ticker so a hidden tab is not clamped to 1/minute');
  assert.ok(shellCode.includes('visibilitychange') && shellCode.includes('"online"'),
    'coming back refreshes immediately instead of waiting out the interval');
  assert.ok(shellCode.includes('renderSignature'), 'identical snapshots do not re-render the room');
});

test('the deck publishes the playhead instead of re-rendering the whole party', () => {
  const nowPlayingCode = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  assert.ok(nowPlayingCode.includes('setPlayhead('), 'the deck publishes to the store');
  assert.ok(!nowPlayingCode.includes('onPositionChange'), 'no per-tick callback into the parent');

  const shellCode = fs.readFileSync('src/components/PartyShell.tsx', 'utf8');
  assert.ok(!shellCode.includes('playheadSec'), 'the shell holds no playhead state');

  const lyricsCode = fs.readFileSync('src/components/LyricsOverlay.tsx', 'utf8');
  assert.ok(lyricsCode.includes('subscribePlayhead'), 'lyrics subscribe to the playhead directly');
  assert.ok(lyricsCode.includes('prev === next ? prev : next'),
    'lyrics only re-render when the highlighted line changes');

  const css = fs.readFileSync('src/app/globals.css', 'utf8');
  assert.ok(!css.includes('animation: grainShift'), 'the full-screen grain layer no longer repaints forever');
  assert.ok(css.includes('prefers-reduced-motion'), 'ambient animation honours the OS setting');
});

test('corrective seeks need strikes, cooldown backoff, and post-buffer settle so playback stops stuttering', () => {
  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  assert.match(code, /SEEK_STRIKES_BEFORE_SEEK = 3/);
  assert.match(code, /SEEK_COOLDOWN_MS = 8000/);
  assert.ok(code.includes('effectiveDriftDeadband(') && code.includes('seekCooldownMs('),
    'deadband and seek backoff adapt to rate support and slow networks');
  assert.ok(code.includes('planDriftCorrection') && code.includes('strikesNeeded'),
    'the strike ladder lives in one pure, tested function');
  assert.ok(code.includes('postBufferHold'),
    'post-buffer settle period prevents seeking immediately after buffering');
  assert.ok(code.includes('PLAY_NUDGE_COOLDOWN_MS'), 'play() nudges are rate limited');
});

test('reloading the page does not bring back the "Tap for sound" prompt', () => {
  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  const muteOnStart = code.slice(code.indexOf('const muteOnStart'), code.indexOf('const muteOnStart') + 220);
  assert.ok(!muteOnStart.includes('soundAllowedRef'),
    'a fresh page always tries unmuted playback instead of pre-emptively muting');
  assert.match(code, /AUTOPLAY_BLOCK_MS = 1800/);
  assert.ok(code.includes('!audiblePlaybackRef.current'),
    'only the first load can fall back to muted; a slow track never silences the room');
  const blockAt = code.indexOf('msSinceLoad > autoplayBlockMs');
  const ladderAt = code.indexOf('loadNeverStarted');
  assert.ok(blockAt > -1 && blockAt < ladderAt,
    'a blocked autoplay is handled before the recovery ladder can rebuild the player');
});

test('deck controls belong to the host only', () => {
  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  const gate = code.indexOf('{np && isAdmin && (');
  assert.ok(gate > -1, 'the control cluster is gated on isAdmin');
  for (const marker of ['aria-label="Volume"', 'Pause for everyone', 'Skip track']) {
    assert.ok(code.indexOf(marker) > gate, `${marker} is inside the host-only block`);
  }
  const progress = code.slice(code.indexOf('Progress — read-only for guests'), gate);
  assert.ok(progress.indexOf('isAdmin && duration > 0 ?') < progress.indexOf('aria-label="Seek"'),
    'only the host can scrub');
  assert.ok(progress.includes('bg-gradient-to-r from-violet-400'),
    'guests still see where the song is, they just cannot move it');
  const recoverySkip = code.slice(code.indexOf('Playback recovery'), gate);
  assert.ok(/isAdmin && \(\s*<button\s+onClick=\{\(\) => adminTransport\("skip"\)\}/.test(recoverySkip),
    'even the recovery overlay only offers Skip to the host');
  assert.ok(code.includes('{isAdmin && (') && code.indexOf('resyncExactMs') > -1,
    'the clock chip is a host tool as well');
  assert.ok(code.includes('{soundBlocked && !playerProblem && ('),
    'the sound escape hatch stays available to everyone');
});

test('PC gets three columns, the phone gets one panel at a time with the deck alive', () => {
  const shellCode = fs.readFileSync('src/components/PartyShell.tsx', 'utf8');
  assert.ok(shellCode.includes('xl:grid-cols-[minmax(380px,1fr)_minmax(460px,1.05fr)_420px]'),
    'wide screens get a generous lyrics column');
  assert.ok(shellCode.includes('grid-cols-5'), 'the phone switcher exposes Deck too');
  const deck = shellCode.slice(shellCode.indexOf('aria-label="Deck"'), shellCode.indexOf('aria-label="Lyrics"'));
  assert.ok(deck.includes('absolute inset-0') && deck.includes('opacity-0') && deck.includes('pointer-events-none'),
    'an inactive deck stays full size and mounted (hidden iframes get throttled)');
  assert.ok(!/hidden/.test(deck), 'the deck is never display:none');
  assert.ok(deck.includes('md:static') && deck.includes('md:opacity-100'),
    'on a laptop the deck is just the middle column again');
});

test('the lyrics panel is transparent, wide and readable', () => {
  const code = fs.readFileSync('src/components/LyricsOverlay.tsx', 'utf8');
  assert.ok(!code.includes('glass-deep'), 'no card background behind the words');
  assert.ok(!/border border-white\/10/.test(code.slice(code.indexOf('<section'), code.indexOf('<header'))),
    'no framing border around the column');
  assert.ok(code.includes('maskImage'), 'lines fade out at the top and bottom instead of being clipped');
  assert.ok(code.includes('px-1 sm:px-2'), 'margins give the text the full column width');
  assert.ok(code.includes('text-2xl') && code.includes('lg:text-3xl'), 'the active line is large');
  assert.ok(code.includes('text-lg') && code.includes('lg:text-xl'), 'surrounding lines are readable too');
});

/* ------------------------------------------------------------------ *
 * Round 3: crossfade between songs, and no replaying the first seconds
 * of a finished track while the room catches up.
 * ------------------------------------------------------------------ */

test('crossfade gains hold constant power across the overlap', () => {
  const { crossfadeGains } = load('src/lib/playback.ts');
  const start = crossfadeGains(0);
  assert.equal(Math.round(start.incoming * 1000), 0);
  assert.equal(Math.round(start.outgoing * 1000), 1000);
  const end = crossfadeGains(1);
  assert.equal(Math.round(end.incoming * 1000), 1000);
  assert.equal(Math.round(end.outgoing * 1000), 0);
  for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const g = crossfadeGains(t);
    const power = g.incoming * g.incoming + g.outgoing * g.outgoing;
    assert.ok(Math.abs(power - 1) < 1e-9, `no volume dip at ${t}`);
  }
  // Out of range input is clamped, never NaN or negative volume.
  assert.deepEqual(crossfadeGains(-5), crossfadeGains(0));
  assert.deepEqual(crossfadeGains(9), crossfadeGains(1));
});

test('the server accepts a crossfade-early end report but not an absurd one', () => {
  const { shouldAcceptEndReport, CROSSFADE_SEC } = load('src/lib/playback.ts');
  const song = { stateDurationSec: 200 };

  assert.ok(shouldAcceptEndReport({ ...song, elapsedSec: 200 }), 'natural end');
  assert.ok(
    shouldAcceptEndReport({ ...song, elapsedSec: 200 - CROSSFADE_SEC }),
    'the early report that opens the crossfade'
  );
  assert.ok(
    shouldAcceptEndReport({ ...song, elapsedSec: 200 - CROSSFADE_SEC - 3 }),
    'slack for poll latency'
  );
  assert.ok(!shouldAcceptEndReport({ ...song, elapsedSec: 120 }),
    'a stale or confused client cannot cut the song in half');
  assert.ok(!shouldAcceptEndReport({ ...song, elapsedSec: 0 }),
    'and certainly not at the very start');

  // Metadata lied and the video is really 3 minutes: the player's own
  // duration wins, otherwise the room would stall until the watchdog.
  assert.ok(
    shouldAcceptEndReport({ ...song, elapsedSec: 180, clientDurationSec: 180 }),
    'short real video still advances immediately'
  );
  assert.ok(
    shouldAcceptEndReport({ ...song, elapsedSec: 100, clientDurationSec: 105 }),
    'the measured length wins over bad metadata'
  );
  assert.ok(
    !shouldAcceptEndReport({ ...song, elapsedSec: 100, clientDurationSec: 3 }),
    'an implausible client duration is ignored, the stored one still guards'
  );
  assert.ok(shouldAcceptEndReport({ elapsedSec: 5, stateDurationSec: 0 }),
    'unknown length: trust the client');

  const route = fs.readFileSync('src/app/api/player/route.ts', 'utf8');
  assert.ok(route.includes('shouldAcceptEndReport'), 'the route applies the guard');
  assert.ok(route.includes('clientDurationSec'), 'and passes the measured duration');
});

test('a finished video is never restarted while the room catches up', () => {
  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  assert.ok(code.includes('if (st === YT_STATE.ENDED) endedHoldRef.current = trackKey'),
    'reaching the end latches a hold');
  assert.ok(code.includes('if (party.isPlaying && !endedHold)'),
    'no play() nudge during the hold - that is what replayed the first seconds');
  assert.ok(/!endedHold &&\s*shouldHealStall/.test(code),
    'and no iframe rebuild either');
  assert.ok(code.includes('expected < party.durationSec - 5'),
    'scrubbing back into the track releases the hold');
  const ended = code.slice(code.indexOf('if (state === YT_STATE.ENDED)'));
  assert.ok(ended.slice(0, 600).includes('endedHoldRef.current = key'),
    'the ENDED event latches the hold too');
});

test('songs overlap: two decks, preload, swap, equal-power fade', () => {
  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  assert.ok(code.includes('hostARef') && code.includes('hostBRef'),
    'two persistent player hosts');
  assert.ok(code.includes('idlePlayerRef'), 'one deck is always free to preload');

  // Preload primes the decoder instead of just cueing (cue does not fetch).
  const preload = code.slice(
    code.indexOf('const preloadNext'),
    code.indexOf('const rebuildPlayer = useCallback')
  );
  assert.ok(preload.includes('loadVideoById') && preload.includes('p.mute()'),
    'the next song is buffered silently');
  assert.ok(code.includes('preloadStateRef.current = "ready"') && code.includes('target.pauseVideo()'),
    'and parked back at 0, ready to resume instantly');

  // The swap hands the room over without tearing the audio down.
  const swap = code.slice(code.indexOf('const swapToIdleDeck'), code.indexOf('/* ---------- load a track onto the live player'));
  assert.ok(swap.includes('playerRef.current = incoming') && swap.includes('idlePlayerRef.current = outgoing'),
    'decks swap roles');
  assert.ok(swap.includes('incoming.playVideo()') && swap.includes('runCrossfade(incoming, outgoing'),
    'a primed deck just resumes - no reload on the hand-over');
  assert.ok(swap.includes('loaded === videoId && primed'),
    'the fast path is only taken when the deck really is primed');
  assert.ok(swap.includes('incoming.loadVideoById'),
    'a cold deck (unexpected skip) still takes over, it just loads first');
  assert.ok(swap.includes('setLoadedKey(trackKey)'), 'no "loading track" flash during a mix');

  assert.ok(code.includes('crossfadeGains'), 'equal-power ramp');
  assert.ok(code.includes('if (!isFading(p)) p.setVolume'),
    'the sync loop does not fight the fade');
  assert.ok(code.includes('naturalEnd ? CROSSFADE_MS : SKIP_FADE_MS'),
    'a skip gets its own (shorter but still real) crossfade');
  assert.ok(code.includes('if (fadeRef.current) stopFade(true)'),
    'pausing the room kills the tail');
});

test('the room timeline moves early so every guest hears the same overlap', () => {
  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  const { CROSSFADE_SEC, PRELOAD_LEAD_SEC, MIN_CROSSFADE_TRACK_SEC } = load('src/lib/playback.ts');
  assert.ok(PRELOAD_LEAD_SEC > CROSSFADE_SEC + 8,
    'the next song has time to boot a player and buffer before the mix');
  assert.ok(MIN_CROSSFADE_TRACK_SEC >= 45, 'short clips are never crossfaded');

  assert.ok(code.includes('remaining <= PRELOAD_LEAD_SEC'), 'preload is scheduled off the playhead');
  assert.ok(code.includes('!slowNetwork &&') && code.includes('!dataSaver'),
    'preloading pauses in slow / Data Saver mode so the active track stays smooth');
  assert.ok(code.includes('shouldArmEarlyEnd({'), 'the early switch is a single decision');
  assert.ok(code.includes('alreadyReported: endedReportedRef.current.has(trackKey)'),
    'reported once per track');
  assert.ok(code.includes('effectiveRemainingSec('),
    'the trigger uses the player clock, not just the metadata duration');
});

test('the early switch does not depend on the preload (that is what killed the overlap)', () => {
  const { shouldArmEarlyEnd, CROSSFADE_SEC, MIN_CROSSFADE_TRACK_SEC, effectiveRemainingSec } =
    load('src/lib/playback.ts');
  const base = { hasNext: true, isPlaying: true, durationSec: 200, alreadyReported: false };

  assert.ok(shouldArmEarlyEnd({ ...base, remainingSec: CROSSFADE_SEC }),
    'armed as soon as the overlap window opens');
  assert.ok(shouldArmEarlyEnd({ ...base, remainingSec: 0.5 }),
    'still armed if a tick was missed');
  assert.ok(!shouldArmEarlyEnd({ ...base, remainingSec: CROSSFADE_SEC + 1 }),
    'not before the window');
  assert.ok(!shouldArmEarlyEnd({ ...base, remainingSec: 1, hasNext: false }),
    'nothing to mix into');
  assert.ok(!shouldArmEarlyEnd({ ...base, remainingSec: 1, isPlaying: false }),
    'not while the room is paused');
  assert.ok(!shouldArmEarlyEnd({ ...base, remainingSec: 1, alreadyReported: true }),
    'once per track');
  assert.ok(
    !shouldArmEarlyEnd({ ...base, remainingSec: 1, durationSec: MIN_CROSSFADE_TRACK_SEC - 1 }),
    'short clips are never cut early'
  );

  // Ground truth: whichever clock says the sound stops sooner.
  assert.equal(effectiveRemainingSec(40, 3), 3, 'a video shorter than its metadata still mixes');
  assert.equal(effectiveRemainingSec(3, 40), 3);
  assert.equal(effectiveRemainingSec(Infinity, 7), 7);
  assert.equal(effectiveRemainingSec(5, null), 5);
  assert.equal(effectiveRemainingSec(Infinity, null), Infinity);

  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  const arm = code.slice(code.indexOf('shouldArmEarlyEnd({'), code.indexOf('shouldArmEarlyEnd({') + 500);
  assert.ok(!arm.includes('preloadStateRef'),
    'the early switch must never wait on the preload - the outgoing tail is what covers the gap');
});

test('the outgoing song covers the gap when the incoming deck is cold', () => {
  const code = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  const { FADE_HOLD_MAX_MS, SKIP_FADE_MS } = load('src/lib/playback.ts');
  assert.ok(FADE_HOLD_MAX_MS >= 1000 && FADE_HOLD_MAX_MS <= 3000);
  assert.ok(SKIP_FADE_MS >= 1500, 'a skip is a real crossfade now, not a 900ms wipe');

  assert.ok(code.includes('if (!f.startedAt)'), 'the ramp waits before it starts');
  assert.ok(code.includes("f.incoming?.getPlayerState() === YT_STATE.PLAYING"),
    'it waits for the new song to be audibly rolling');
  assert.ok(code.includes('now - f.createdAt < FADE_HOLD_MAX_MS'), 'with a hard cap');
  const hold = code.slice(code.indexOf('if (!rolling && now - f.createdAt'));
  assert.ok(hold.slice(0, 400).includes('f.outgoing?.setVolume(roomVolume)'),
    'and holds the old song at FULL volume until then');

  assert.ok(code.includes('Math.min(wanted, Math.round(outgoingRemaining * 1000))'),
    'the fade never outlasts the audio the outgoing deck has left');
  assert.ok(code.includes('naturalEnd ? CROSSFADE_MS : SKIP_FADE_MS'),
    'skips crossfade too');
  const boot = code.slice(code.indexOf('!slowNetwork &&') - 20, code.indexOf('mountIdleDeck();', code.indexOf('crossfade scheduling')) + 30);
  assert.ok(boot.includes('!idlePlayerRef.current') && boot.includes('mountIdleDeck()'),
    'on healthy connections the second deck boots early so skips crossfade too');
  assert.ok(code.includes('preloadStateRef.current = "ready"') &&
    code.includes('idleVideo === preloadedVideoRef.current'),
    'preload readiness is polled, not only event driven');
});

/* ------------------------------------------------------------------ *
 * Round 5: the queue must not dress up the next song as if it were
 * already playing, and the song title must never be squeezed out of
 * its row by a badge or by the admin buttons.
 * ------------------------------------------------------------------ */

test('queue rows: only the playing track gets playback animation', () => {
  const code = fs.readFileSync('src/components/QueuePanel.tsx', 'utf8');

  const upNext = code.slice(code.indexOf('3. UP NEXT QUEUE'));
  assert.ok(upNext.length > 500, 'found the Up Next section');
  assert.ok(!upNext.includes('eq-bar'),
    'no equalizer bars on a queued song - that is the "now playing" language');
  assert.ok(!upNext.includes('animate-pulse'),
    'nothing pulses in the queue, a queued song is not live');
  assert.ok(upNext.includes('Up next') && upNext.includes('Plays next'),
    'the first queued row still says it plays next');

  // The real player keeps its equalizer.
  const nowPlaying = code.slice(
    code.indexOf('2. ACTIVE ANCHOR'),
    code.indexOf('3. UP NEXT QUEUE'),
  );
  assert.ok(nowPlaying.includes('eq-bar'),
    'the currently playing row keeps the equalizer');
});

test('queue rows: the song title owns the full width of its row', () => {
  const code = fs.readFileSync('src/components/QueuePanel.tsx', 'utf8');

  // A shrink-0 pill inline with a truncated title starves the title.
  assert.ok(!/shrink-0[^"]*rounded-full[^"]*uppercase/.test(code),
    'no shrink-0 badge sharing a line with a title');
  assert.ok(!code.includes('truncate text-[13px] font-semibold'),
    'titles are clamped over two lines instead of a single truncated line');

  for (const marker of ['{q.title}', '{nowPlaying.title}', '{h.title}']) {
    const at = code.indexOf(marker);
    assert.ok(at > 0, `renders ${marker}`);
    const around = code.slice(at - 320, at);
    assert.ok(around.includes('line-clamp-2'), `${marker} can wrap to two lines`);
    assert.ok(around.includes('title='), `${marker} exposes the full name on hover`);
  }

  // Admin buttons float over the row on wide screens instead of reserving
  // width next to the title, and drop to their own line on a phone.
  assert.ok(code.includes('row-actions'), 'action clusters use the floating helper');
  assert.ok(!code.includes('lg:opacity-0 lg:transition lg:group-hover:opacity-100'),
    'the old invisible-but-space-consuming button strip is gone');
  const css = fs.readFileSync('src/app/globals.css', 'utf8');
  assert.ok(/\.row-actions\s*\{[^}]*position:\s*absolute/.test(css),
    'row-actions is taken out of flow on pointer devices');
  assert.ok(css.includes('(hover: hover)'),
    'touch screens keep the buttons visible in flow');
});

/* ------------------------------------------------------------------ *
 * Round 6: smooth playback on slow connections & Data Saver mode.
 * ------------------------------------------------------------------ */

test('slow-network & Data Saver safeguards protect active buffering and cut unnecessary traffic', () => {
  const npCode = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  const shellCode = fs.readFileSync('src/components/PartyShell.tsx', 'utf8');
  const qpCode = fs.readFileSync('src/components/QueuePanel.tsx', 'utf8');

  // Focusing the browser tab must not force-seek and flush the YouTube buffer.
  const visBlock = npCode.slice(npCode.indexOf('const onVisible ='), npCode.indexOf('const onVisible =') + 250);
  assert.ok(visBlock.includes('sync(false)') && !visBlock.includes('sync(true)'),
    'visibility/focus recovery inspects sync without blind forced seeking');

  // Pending initial seek checks current position before flushing buffered start.
  const pendingAt = npCode.indexOf('if (pendingSeekRef.current');
  const pendingSeekBlock = npCode.slice(pendingAt, pendingAt + 750);
  assert.ok(pendingSeekBlock.includes('Math.abs(cur - targetSec) > snapTol'),
    'initial load only seeks when playback actually landed off-beat');

  // Buffering stalls feed into the network profile so Smooth mode engages automatically.
  assert.ok(npCode.includes('recordBufferingStall('), 'mid-song buffering triggers Smooth mode');
  assert.ok(npCode.includes('DATA_SAVER_IFRAME_PX = 220') && npCode.includes('applyDataSaverQuality('),
    'Data Saver constrains iframe viewport and hints low video quality');
  assert.ok(npCode.includes('45_000'), 'background /api/time bursts are throttled and skipped when synced');

  // Header exposes the Data Saver / Smooth toggle and passes slow status to poll cadence.
  assert.ok(shellCode.includes('toggleDataSaver()') && shellCode.includes('slow: netProfileRef.current.slowNetwork'),
    'PartyShell exposes Data Saver toggle and adapts poll cadence');
  assert.ok(shellCode.includes('shouldResetClockOnRecovery('),
    'clock samples are preserved across brief slow spells and only reset after long outages');

  // Queue panel skips /api/suggestions churn on queue changes and Data Saver mode.
  assert.ok(qpCode.includes('if (netProfile.dataSaver) return;'),
    'Data Saver skips remote suggestion searches');
  const sqCall = qpCode.slice(qpCode.indexOf('const suggestionQuery = buildSuggestionQuery('), qpCode.indexOf('const loadingSuggestions'));
  assert.ok(!sqCall.includes('exclude:'),
    'queue additions/removals do not re-fetch /api/suggestions when nowPlaying is unchanged');
});

