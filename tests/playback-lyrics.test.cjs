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

  // A track that should be playing but sits UNSTARTED gets healed...
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: -1, msSinceHealthy: 5000, recoveryPending: false }), true);
  // ...while buffering, an intentional pause, or a pending retry are left alone.
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: 3, msSinceHealthy: 5000, recoveryPending: false }), false);
  assert.equal(shouldHealStall({ shouldPlay: false, playerState: 2, msSinceHealthy: 5000, recoveryPending: false }), false);
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: -1, msSinceHealthy: 5000, recoveryPending: true }), false);
  assert.equal(shouldHealStall({ shouldPlay: true, playerState: -1, msSinceHealthy: 500, recoveryPending: false }), false);

  // The new video never took: still showing the previous id -> reload it.
  assert.equal(shouldRetryLoad({ expectedVideoId: 'new', actualVideoId: 'old', playerState: 1, shouldPlay: true, msSinceLoad: 4000 }), true);
  assert.equal(shouldRetryLoad({ expectedVideoId: 'new', actualVideoId: 'new', playerState: 1, shouldPlay: true, msSinceLoad: 4000 }), false);
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
  assert.ok(queueCode.includes('Next playing') && queueCode.includes('Played earlier') && queueCode.includes('Suggested for the Queue'));

  const playerRoute = fs.readFileSync('src/app/api/player/route.ts', 'utf8');
  assert.ok(playerRoute.includes('"unplayable"'), 'Server can skip a video nobody can embed');
});
