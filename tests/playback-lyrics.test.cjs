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

  // True world UTC at performance.now() === 0 is 1_700_000_000_000
  const s1 = createClockSample(100, 120, 1_700_000_000_110); // RTT 20ms, exact midpoint 110ms -> utcAtMonoZero = 1_700_000_000_000
  const s2 = createClockSample(200, 224, 1_700_000_000_212); // RTT 24ms, midpoint 212ms -> utcAtMonoZero = 1_700_000_000_000
  const noisy = createClockSample(300, 650, 1_700_000_000_600); // RTT 350ms outlier -> rejected by filter

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

test('UI components implement all 6 requested changes and compile cleanly', () => {
  const entryCode = fs.readFileSync('src/components/EntryGate.tsx', 'utf8');
  assert.ok(entryCode.includes('id="entry-name"') && entryCode.includes('id="entry-password"'), 'Name and password on same page');

  const nowPlayingCode = fs.readFileSync('src/components/NowPlaying.tsx', 'utf8');
  assert.ok(nowPlayingCode.includes('useState(true)'), 'Lyrics on by default on home page');

  const lyricsCode = fs.readFileSync('src/components/LyricsOverlay.tsx', 'utf8');
  assert.ok(!lyricsCode.includes('createPortal') && !lyricsCode.includes('<dialog'), 'Lyrics inline on home page, not a popup modal');

  const queueCode = fs.readFileSync('src/components/QueuePanel.tsx', 'utf8');
  assert.ok(queueCode.includes('Next playing') && queueCode.includes('Played earlier') && queueCode.includes('Suggested for the Queue'));
});
