const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
function load(path, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...globals });
  return exports;
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
