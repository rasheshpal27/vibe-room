/**
 * Round-6 unit tests: the pure modules behind clock sharing, reconnect
 * behaviour, request retries, pasted links, reactions, rate limiting and
 * per-track theming.
 *
 * Same trick as playback-lyrics.test.cjs — transpile the TypeScript source
 * in-memory and run it in a VM with whatever globals the module expects, so
 * there is no build step and no browser.
 */
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
  // Cross-realm values fail assert.deepEqual on prototype identity, so
  // structural comparisons in this file go through JSON.
  const customRequire = (id) => {
    if (id.startsWith('.')) {
      const resolved = path.resolve(dir, id + (id.endsWith('.ts') ? '' : '.ts'));
      if (fs.existsSync(resolved)) return load(resolved, globals);
    }
    if (id.startsWith('@/')) {
      const resolved = path.resolve('src', id.slice(2) + '.ts');
      if (fs.existsSync(resolved)) return load(resolved, globals);
    }
    return require(id);
  };
  const compiled = transpileTs(fs.readFileSync(filePath, 'utf8'), filePath);
  vm.runInNewContext(compiled, {
    exports,
    module: moduleObj,
    require: customRequire,
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    Math,
    Date,
    JSON,
    Number,
    Infinity,
    Set,
    Map,
    Promise,
    AbortController,
    Error,
    ...globals,
  });
  return moduleObj.exports;
}

/* ---------------------------------------------------------------- clock */

test('the clock store prefers the lowest-RTT anchor and ignores slow samples', () => {
  const perf = { now: () => perf.value, value: 1000 };
  const store = load('src/lib/clock-store.ts', { performance: perf });

  store.resetClockSamples();
  assert.equal(store.getClockState().synced, false);

  // A 400ms round trip: the server stamp is assumed to be mid-flight.
  perf.value = 1000;
  store.addClockSample(1000, 1400, Date.now() + 5000);
  const first = store.getClockState();
  assert.equal(first.synced, true);
  assert.equal(first.sampleCount, 1);
  assert.ok(Math.abs(first.bestRttMs - 400) < 1);

  // A faster round trip wins the anchor.
  store.addClockSample(2000, 2040, Date.now() + 5000);
  assert.ok(store.getClockState().bestRttMs <= 40);

  // A 6-second round trip tells us nothing about the clock and is dropped.
  const before = store.getClockState().sampleCount;
  store.addClockSample(3000, 9000, Date.now() + 5000);
  assert.equal(store.getClockState().sampleCount, before);
});

test('subscribers see every new sample and can unsubscribe', () => {
  const perf = { now: () => 0 };
  const store = load('src/lib/clock-store.ts', { performance: perf });
  store.resetClockSamples();

  let seen = 0;
  const off = store.subscribeClock(() => seen++);
  store.addClockSample(0, 20, Date.now());
  store.addClockSample(0, 20, Date.now());
  assert.equal(seen, 2);

  off();
  store.addClockSample(0, 20, Date.now());
  assert.equal(seen, 2);
});

test('a snapshot seed only applies before a real sample has landed', () => {
  const perf = { now: () => 0 };
  const store = load('src/lib/clock-store.ts', { performance: perf });

  store.resetClockSamples();
  const seeded = store.seedClockFromServerNow(Date.now() + 30000);
  assert.ok(Math.abs(seeded.offsetMs - 30000) < 50);

  // Once a measured sample exists the coarse seed must not clobber it.
  store.resetClockSamples();
  store.addClockSample(0, 10, Date.now());
  const measured = store.getClockState().offsetMs;
  store.seedClockFromServerNow(Date.now() + 30000);
  assert.equal(store.getClockState().offsetMs, measured);
});

/* ----------------------------------------------------------- connection */

test('connection status needs two consecutive failures before it cries wolf', () => {
  const c = load('src/lib/connection.ts');
  assert.equal(c.connectionStatus(0, true), 'online');
  assert.equal(c.connectionStatus(1, true), 'online');
  assert.equal(c.connectionStatus(2, true), 'reconnecting');
  // navigator.onLine trumps everything.
  assert.equal(c.connectionStatus(0, false), 'offline');
});

test('poll delay backs off exponentially, jitters, and respects the hidden floor', () => {
  const c = load('src/lib/connection.ts');

  assert.equal(c.nextPollDelayMs({ failures: 0, hidden: false, online: true }), 1000);
  assert.equal(c.nextPollDelayMs({ failures: 0, hidden: true, online: true }), 6000);
  assert.equal(c.nextPollDelayMs({ failures: 9, hidden: false, online: false }), 3000);

  // 3 failures -> 4000ms base, +/-25%.
  assert.equal(c.nextPollDelayMs({ failures: 3, hidden: false, online: true, random: 0 }), 3000);
  assert.equal(c.nextPollDelayMs({ failures: 3, hidden: false, online: true, random: 0.999 }), 4998);

  // Backoff is capped.
  assert.equal(c.nextPollDelayMs({ failures: 50, hidden: false, online: true, random: 0.5 }), 20000);

  // A backed-off hidden tab never polls faster than the hidden floor.
  assert.ok(c.nextPollDelayMs({ failures: 1, hidden: true, online: true, random: 0 }) >= 6000);
});

test('recovery forces a hard resync after a real gap, not after a blip', () => {
  const c = load('src/lib/connection.ts');
  // One dropped poll, picked straight back up: the deck is still accurate.
  assert.equal(c.shouldForceResyncOnRecovery(1, 500), false, 'blip');
  // Four seconds without a confirmed snapshot: the playhead is a guess now.
  assert.equal(c.shouldForceResyncOnRecovery(1, 5000), true, 'four seconds blind');
  // A hidden tab polls every 6s and never "fails", but still coasted.
  assert.equal(c.shouldForceResyncOnRecovery(0, 10000), true, 'long quiet gap');
  // Enough failures to have shown the reconnect banner always re-anchors.
  assert.equal(c.shouldForceResyncOnRecovery(2, 0), true, 'was visibly reconnecting');
});

/* ------------------------------------------------------------------ net */

test('only idempotent player reports are safe to retry', () => {
  const net = load('src/lib/net.ts');
  assert.equal(net.isIdempotentAction('ended'), true);
  assert.equal(net.isIdempotentAction('duration'), true);
  assert.equal(net.isIdempotentAction('unplayable'), true);
  // Replaying these would skip two songs or double-toggle the room.
  assert.equal(net.isIdempotentAction('next'), false);
  assert.equal(net.isIdempotentAction('toggle'), false);
  assert.equal(net.isIdempotentAction('seek'), false);
});

test('retries cover transport loss and server faults, never client errors', () => {
  const net = load('src/lib/net.ts');
  assert.equal(net.shouldRetryResponse(null), true, 'network error / timeout');
  assert.equal(net.shouldRetryResponse({ ok: false, status: 500 }), true);
  assert.equal(net.shouldRetryResponse({ ok: false, status: 503 }), true);
  assert.equal(net.shouldRetryResponse({ ok: false, status: 429 }), false, 'rate limited: backing off is the point');
  assert.equal(net.shouldRetryResponse({ ok: false, status: 403 }), false);
  assert.equal(net.shouldRetryResponse({ ok: true, status: 200 }), false);
});

/* ---------------------------------------------------------- youtube-url */

test('pasted YouTube links of every shape resolve to a video id', () => {
  const u = load('src/lib/youtube-url.ts');
  const cases = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    '  youtube.com/watch?v=dQw4w9WgXcQ  ',
    'dQw4w9WgXcQ',
  ];
  for (const input of cases) {
    const target = u.parseYouTubeTarget(input);
    assert.equal(target && target.kind, 'video', input);
    assert.equal(target.videoId, 'dQw4w9WgXcQ', input);
  }
});

test('a start time survives the paste, in every format YouTube emits', () => {
  const u = load('src/lib/youtube-url.ts');
  assert.equal(u.parseYouTubeTarget('https://youtu.be/dQw4w9WgXcQ?t=90').startSec, 90);
  assert.equal(u.parseYouTubeTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s').startSec, 90);
  assert.equal(u.parseYouTubeTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s').startSec, 3723);
  assert.equal(u.parseYouTubeTarget('https://youtu.be/dQw4w9WgXcQ?t=45s').startSec, 45);
  assert.equal(u.parseYouTubeTarget('https://youtu.be/dQw4w9WgXcQ').startSec, 0);
});

test('playlists are recognised, and non-YouTube text is not', () => {
  const u = load('src/lib/youtube-url.ts');
  const list = u.parseYouTubeTarget('https://www.youtube.com/playlist?list=PLabc123DEF456');
  assert.equal(list.kind, 'playlist');
  assert.equal(list.listId, 'PLabc123DEF456');

  // A watch URL that also carries a list is still a video: play what was clicked.
  const both = u.parseYouTubeTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123DEF456');
  assert.equal(both.kind, 'video');
  assert.equal(both.listId, 'PLabc123DEF456');

  assert.equal(u.parseYouTubeTarget('tame impala let it happen'), null);
  assert.equal(u.parseYouTubeTarget('https://open.spotify.com/track/abc'), null);
  assert.equal(u.parseYouTubeTarget(''), null);
});

/* ------------------------------------------------------------ reactions */

test('only the six house emoji are accepted as reactions', () => {
  const r = load('src/lib/reactions.ts');
  assert.equal(r.REACTION_EMOJI.length, 6);
  for (const e of r.REACTION_EMOJI) assert.equal(r.isReactionEmoji(e), true);
  assert.equal(r.isReactionEmoji('💩'), false);
  assert.equal(r.isReactionEmoji('fire'), false);
  assert.equal(r.isReactionEmoji(null), false);
  assert.equal(r.isReactionEmoji(42), false);
});

test('reaction lanes are deterministic and spread across the screen', () => {
  const r = load('src/lib/reactions.ts');
  const lanes = new Set();
  for (let id = 1; id <= 40; id++) {
    const lane = r.reactionLane(id);
    // A percentage, used directly as a `left:` offset.
    assert.ok(lane >= 0 && lane <= 100, `lane ${lane} out of range`);
    lanes.add(lane);
  }
  assert.ok(lanes.size >= 30, 'consecutive ids must not stack in one column');
  // Golden-ratio hashing: neighbouring ids land far apart.
  assert.ok(Math.abs(r.reactionLane(11) - r.reactionLane(12)) > 20);
  assert.equal(r.reactionLane(7), r.reactionLane(7), 'same id, same lane across re-renders');
});

/* ----------------------------------------------------------- rate limit */

test('the token bucket allows a burst, then refills at the configured rate', () => {
  const rl = load('src/lib/rate-limit.ts');
  const rule = { capacity: 3, refillPerSec: 1 };

  let state;
  for (let i = 0; i < 3; i++) {
    const v = rl.takeToken(state, rule, 0);
    assert.equal(v.allowed, true, `burst ${i}`);
    state = v.state;
  }

  const denied = rl.takeToken(state, rule, 0);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec >= 1);
  assert.equal(denied.remaining, 0);

  // One second later exactly one token is back.
  const after = rl.takeToken(denied.state, rule, 1000);
  assert.equal(after.allowed, true);
  assert.equal(rl.takeToken(after.state, rule, 1000).allowed, false);

  // Idle for an hour: refill is capped at capacity, not unbounded.
  const rested = rl.takeToken(after.state, rule, 3_600_000);
  assert.ok(rested.remaining <= rule.capacity);
});

test('rate limiting is per key, and the auth rule is the strictest', () => {
  const rl = load('src/lib/rate-limit.ts');
  rl.resetRateLimits();

  for (let i = 0; i < rl.RULES.auth.capacity; i++) {
    assert.equal(rl.rateLimit('auth:1.2.3.4', rl.RULES.auth, 0).allowed, true);
  }
  assert.equal(rl.rateLimit('auth:1.2.3.4', rl.RULES.auth, 0).allowed, false);
  // A different guest is unaffected.
  assert.equal(rl.rateLimit('auth:5.6.7.8', rl.RULES.auth, 0).allowed, true);

  assert.ok(rl.RULES.auth.refillPerSec < rl.RULES.chat.refillPerSec);
  assert.ok(rl.RULES.chat.capacity < rl.RULES.queue.capacity);
});

test('the client ip comes from the first forwarded hop', () => {
  const rl = load('src/lib/rate-limit.ts');
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' });
  assert.equal(rl.clientIp(headers), '203.0.113.9');
  assert.equal(rl.clientIp(new Headers({ 'x-real-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(rl.clientIp(new Headers()), 'unknown');
});

/* ------------------------------------------------------- env / secrets */

test('auth fails closed when the passwords are not configured', () => {
  const env = load('src/lib/env.ts', { process: { env: {} } });
  assert.equal(env.missingSecrets().sort().join(','), 'ADMIN_PASSWORD,PARTY_PASSWORD');
  assert.equal(env.authConfigured(), false);
  // No secret set must never mean "everything is allowed".
  assert.equal(env.verifyPartyPassword(''), false);
  assert.equal(env.verifyPartyPassword('anything'), false);
  assert.equal(env.verifyAdminPassword('anything'), false);
  const payload = env.configErrorPayload();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'not-configured');
  // The message has to be actionable: name the variables that are missing.
  assert.match(payload.error, /PARTY_PASSWORD/);
  assert.match(payload.error, /ADMIN_PASSWORD/);
});

test('password checks are exact, type-safe and length-independent', () => {
  const env = load('src/lib/env.ts', {
    process: { env: { PARTY_PASSWORD: 'let-me-in', ADMIN_PASSWORD: 'host-only-7' } },
  });
  assert.equal(env.authConfigured(), true);
  assert.equal(env.missingSecrets().length, 0);

  assert.equal(env.verifyPartyPassword('let-me-in'), true);
  assert.equal(env.verifyPartyPassword('let-me-in '), false);
  assert.equal(env.verifyPartyPassword('LET-ME-IN'), false);
  assert.equal(env.verifyPartyPassword('let-me'), false, 'a prefix is not a password');
  assert.equal(env.verifyPartyPassword(undefined), false);
  assert.equal(env.verifyPartyPassword(123), false);

  assert.equal(env.verifyAdminPassword('host-only-7'), true);
  assert.equal(env.verifyAdminPassword('let-me-in'), false, 'guest password is not host password');
});

/* ---------------------------------------------------------- theming */

test('hsl round-trips and the derived theme keeps a usable contrast', () => {
  const p = load('src/lib/palette.ts');
  for (const rgb of [{ r: 167, g: 139, b: 250 }, { r: 12, g: 200, b: 90 }, { r: 0, g: 0, b: 0 }]) {
    const { h, s, l } = p.rgbToHsl(rgb);
    const back = p.hslToRgb(h, s, l);
    assert.ok(Math.abs(back.r - rgb.r) <= 2 && Math.abs(back.g - rgb.g) <= 2 && Math.abs(back.b - rgb.b) <= 2);
  }

  // A near-black cover must not produce an invisible room.
  const theme = p.themeFromColor({ r: 8, g: 8, b: 10 });
  const { l } = p.rgbToHsl(theme.accent);
  assert.ok(l > 0.3, `accent too dark: ${l}`);
  assert.equal(p.rgbString(theme.accent).split(' ').length, 3);
});

test('the dominant colour ignores greys and the letterbox, and falls back safely', () => {
  const p = load('src/lib/palette.ts');
  const px = (r, g, b) => [r, g, b, 255];

  // Mostly dark grey frame with a small saturated patch: the patch should win.
  const data = [];
  for (let i = 0; i < 300; i++) data.push(...px(18, 18, 20));
  for (let i = 0; i < 40; i++) data.push(...px(230, 60, 160));
  const picked = p.dominantColor(new Uint8ClampedArray(data));
  assert.ok(picked.r > 120 && picked.b > 80, `expected the pink, got ${JSON.stringify(picked)}`);

  // An entirely grey thumbnail has no story to tell: say so, and let the
  // caller keep the house palette rather than painting the room beige.
  const grey = [];
  for (let i = 0; i < 300; i++) grey.push(...px(128, 128, 128));
  assert.equal(p.dominantColor(new Uint8ClampedArray(grey)), null);

  // Fully transparent padding is skipped, not averaged in as black.
  const padded = [];
  for (let i = 0; i < 200; i++) padded.push(0, 0, 0, 0);
  for (let i = 0; i < 60; i++) padded.push(...px(40, 120, 220));
  const blue = p.dominantColor(new Uint8ClampedArray(padded));
  assert.ok(blue && blue.b > blue.r, `expected the blue, got ${JSON.stringify(blue)}`);
});

/* ------------------------------------------------- soft drift steering */

test('small drift is steered with playback rate, not a seek', () => {
  const pb = load('src/lib/playback.ts');
  const base = { strikes: 0, seekCooledDown: false, force: false, rateSupported: true };

  // Ahead of the room -> ease off.
  const ahead = pb.planDriftCorrection({ ...base, driftSec: 0.45, currentRate: 1 });
  assert.equal(ahead.kind, 'rate');
  assert.ok(ahead.rate < 1);

  // Behind -> catch up.
  const behind = pb.planDriftCorrection({ ...base, driftSec: -0.45, currentRate: 1 });
  assert.equal(behind.kind, 'rate');
  assert.ok(behind.rate > 1);

  // Already steering the right way: say nothing rather than re-issue it.
  assert.equal(
    pb.planDriftCorrection({ ...base, driftSec: -0.45, currentRate: behind.rate }).kind,
    'none'
  );

  // Back on the beat -> hand the deck back to 1.0x.
  const settled = pb.planDriftCorrection({ ...base, driftSec: 0.05, currentRate: behind.rate });
  assert.equal(settled.kind, 'rate');
  assert.equal(settled.rate, 1);
});

test('steering gives way to a seek when it is hopeless, or unsupported', () => {
  const pb = load('src/lib/playback.ts');
  const struck = { strikes: 2, seekCooledDown: true, force: false, rateSupported: true };

  // Miles out: no amount of 0.97x is going to fix this.
  assert.equal(pb.planDriftCorrection({ ...struck, driftSec: 9, currentRate: 1 }).kind, 'seek');

  // A player that refused the rate change falls back to the seek ladder.
  assert.equal(
    pb.planDriftCorrection({ ...struck, driftSec: 0.6, currentRate: 1, rateSupported: false }).kind,
    'seek'
  );
  // ...but still does nothing inside the deadband.
  assert.equal(
    pb.planDriftCorrection({ ...struck, driftSec: 0.05, currentRate: 1, rateSupported: false }).kind,
    'none'
  );

  // A forced resync always seeks.
  assert.equal(
    pb.planDriftCorrection({ ...struck, driftSec: 0, currentRate: 1, force: true }).kind,
    'seek'
  );
  // Garbage in, nothing out.
  assert.equal(pb.planDriftCorrection({ ...struck, driftSec: NaN, currentRate: 1 }).kind, 'none');
});

test('steering time is finite only while the rate is actually off 1.0x', () => {
  const pb = load('src/lib/playback.ts');
  assert.equal(pb.steeringSecondsFor(0.3, 1), Infinity);
  // 0.3s of drift at 3% speed difference takes 10s to erase.
  assert.ok(Math.abs(pb.steeringSecondsFor(0.3, 1.03) - 10) < 0.001);
  assert.ok(Math.abs(pb.steeringSecondsFor(-0.3, 0.97) - 10) < 0.001);
});
