const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync('docs/js/speech-system.js', 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export class', 'class')
  .replace('export const narrator', 'const narrator') + '\nglobalThis.speech = narrator;';

function fixture(userAgent = 'Android Chrome') {
  let now = 0, nextId = 0, cancels = 0;
  const timers = new Map(), spoken = [], nativeQueue = [];
  const announcer = { textContent: '' }, writes = [];
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [],
    speak(u) { spoken.push(u); nativeQueue.push(u); this.pending = true; },
    cancel() { cancels++; nativeQueue.length = 0; this.speaking = this.pending = false; },
    resume() { this.paused = false; }
  };
  const context = vm.createContext({
    window: { speechSynthesis: synth, navigator: { userAgent } },
    document: { getElementById: id => id === 'sr-announcer' ? announcer : null },
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    readSetting: () => null, writeSetting: (...args) => writes.push(args), Date: { now: () => now },
    console: { debug() {}, warn() {} },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(source, context);
  const s = context.speech;
  s.setDiagnosticsEnabled(true);
  function advance(ms) {
    const target = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = target;
  }
  function start(u = spoken.at(-1)) {
    synth.speaking = true; synth.pending = nativeQueue.length > 1;
    u.onstart({});
  }
  function idle() { nativeQueue.length = 0; synth.speaking = synth.pending = false; }
  function end(u = spoken.at(-1)) { idle(); u.onend({}); }
  function released() {
    assert.equal(s.testUtterance, null); assert.equal(s.utterances.size, 0);
    assert.equal(s.watchdogs.size, 0); assert.equal(timers.size, 0);
  }
  return { s, synth, spoken, nativeQueue, timers, announcer, writes, advance, start, idle, end, released,
    get cancels() { return cancels; } };
}

for (const ua of ['Android Chrome', 'Windows Chrome', 'iPhone Safari']) {
  test(`${ua}: five completed tests each call speak and release references`, () => {
    const f = fixture(ua);
    for (let i = 1; i <= 5; i++) {
      f.s.testSpeech(); assert.equal(f.spoken.length, i);
      assert.equal(f.spoken.at(-1).text, '音声案内のテストです。');
      f.start(); f.advance(2000); f.end(); f.released();
    }
    assert.equal(f.cancels, 0);
    assert.equal(f.s.getDiagnostics().filter(e => e.type === 'speak-called').length, 5);
  });
}

test('missing end: observed busy then stable idle releases without cancel or retry', () => {
  const f = fixture();
  f.s.testSpeech(); const old = f.spoken.at(-1); f.start(); f.advance(2000); f.idle();
  f.advance(500); f.s.testSpeech(); assert.equal(f.spoken.length, 1);
  f.advance(1000); f.released(); assert.equal(f.cancels, 0);
  assert.equal(f.s.getDiagnostics().at(-1).type, 'speech-idle-recovered');
  f.s.testSpeech(); assert.equal(f.spoken.length, 2); const next = f.spoken.at(-1);
  old.onend({}); old.onerror({ error: 'interrupted' });
  assert.equal(f.s.testUtterance, next); assert.equal(f.cancels, 0);
  f.start(); f.advance(2000); f.end(); f.released();
  f.s.speak('プレー。あなたのサーブです。'); f.start(); f.advance(2000); f.end(); f.released();
});

test('rapid clicks during pending and speaking never duplicate or cancel', () => {
  const f = fixture(); f.s.testSpeech();
  for (let i = 0; i < 20; i++) f.s.testSpeech();
  f.start(); f.advance(10000);
  for (let i = 0; i < 20; i++) f.s.testSpeech();
  assert.equal(f.spoken.length, 1); assert.equal(f.cancels, 0);
  f.end(); f.released(); f.s.testSpeech(); assert.equal(f.spoken.length, 2);
});

test('transient idle, pending and paused are not treated as completion', () => {
  const f = fixture(); f.s.testSpeech(); f.start(); f.advance(2000);
  f.synth.speaking = false; f.advance(500);
  f.synth.speaking = true; f.advance(500);
  f.synth.speaking = false; f.synth.pending = true; f.advance(2000);
  f.synth.pending = false; f.synth.paused = true; f.advance(2000);
  f.s.testSpeech(); assert.equal(f.spoken.length, 1); assert.equal(f.cancels, 0);
  f.s.stop(); f.released();
});

test('false flags without a busy observation do not permit premature overlapping speech', () => {
  const f = fixture();
  // API復帰直後もpending/speakingが一度もtrueにならないエンジン。
  f.synth.speak = u => f.spoken.push(u);
  f.s.testSpeech(); f.idle(); f.spoken.at(-1).onstart({});
  f.advance(5000); f.s.testSpeech(); assert.equal(f.spoken.length, 1);
  f.advance(25000); f.released(); assert.equal(f.cancels, 1);
  f.s.testSpeech(); assert.equal(f.spoken.length, 2);
});

test('stuck flags and missing terminal event cancel once at existing deadline and accept next test', () => {
  const f = fixture(); f.s.testSpeech(); const old = f.spoken.at(-1); f.start();
  f.advance(29999); assert.equal(f.cancels, 0); assert.equal(f.s.testUtterance, old);
  f.advance(1); f.released(); assert.equal(f.cancels, 1); assert.equal(f.nativeQueue.length, 0);
  assert.equal(f.s.getDiagnostics().find(e => e.type === 'stop').category, 'recovery');
  f.advance(120000); assert.equal(f.cancels, 1); assert.equal(f.spoken.length, 1);
  f.s.testSpeech(); const next = f.spoken.at(-1); assert.equal(f.spoken.length, 2);
  old.onerror({ error: 'interrupted' }); assert.equal(f.s.testUtterance, next);
  assert.equal(f.s.getDiagnostics().at(-1).category, 'recovery');
  f.start(); f.advance(2000); f.end(); f.released();
});

for (const error of ['canceled', 'interrupted', 'synthesis-failed', 'not-allowed', 'audio-hardware']) {
  test(`${error}: clear blocked queued calls and permit a completed next test`, () => {
    const f = fixture(); f.s.testSpeech(); f.start(); const failed = f.spoken.at(-1);
    f.s.speak('古い待機コール'); const queued = f.spoken.at(-1);
    failed.onerror({ error }); f.released(); assert.equal(f.nativeQueue.length, 0);
    assert.equal(f.cancels, 1);
    assert.equal(f.s.getDiagnostics().find(e => e.type === 'error').category,
      ['canceled', 'interrupted'].includes(error) ? 'queue-interruption' : 'engine-error');
    f.s.testSpeech(); const next = f.spoken.at(-1);
    queued.onerror({ error: 'canceled' }); failed.onend({});
    assert.equal(f.s.testUtterance, next); assert.equal(f.cancels, 1);
    f.start(); f.advance(2000); f.end(); f.released();
  });
}

test('stop followed by another test ignores late canceled events and clears timers', () => {
  const f = fixture(); f.s.testSpeech(); f.start(); const old = f.spoken.at(-1);
  f.s.stop(); f.released(); f.s.testSpeech(); const next = f.spoken.at(-1);
  old.onerror({ error: 'interrupted' }); assert.equal(f.s.getDiagnostics().at(-1).category, 'explicit-stop');
  old.onend({}); assert.equal(f.s.testUtterance, next); assert.equal(f.cancels, 1);
  f.start(); f.advance(2000); f.end(); f.released();
});

test('missing start event and paused queue recover without automatic retries', () => {
  for (const paused of [false, true]) {
    const f = fixture(); f.s.testSpeech(); f.synth.paused = paused;
    f.advance(30000); f.released(); assert.equal(f.cancels, 1);
    assert.equal(f.s.getDiagnostics().find(e => e.type === 'speech-timeout').category,
      paused ? 'queue-paused' : 'start-not-received');
    f.s.testSpeech(); assert.equal(f.spoken.length, 2); assert.equal(f.synth.paused, false);
    f.start(); f.advance(2000); f.end(); f.released();
  }
});

for (const ua of ['Windows Chrome', 'iPhone Safari']) {
  test(`${ua}: test watchdog recovers when end is missing`, () => {
    const f = fixture(ua); f.s.testSpeech(); f.start(); f.advance(30000);
    f.released(); assert.equal(f.cancels, 1);
    f.s.testSpeech(); assert.equal(f.spoken.length, 2);
    f.start(); f.advance(2000); f.end(); f.released();
  });
}

test('a queued test does not time out while an earlier long referee call is active', () => {
  const f = fixture(); f.s.setSpeechRate(0.5);
  f.s.speak('長い審判案内'.repeat(8)); const first = f.spoken.at(-1); f.start(first);
  f.s.testSpeech(); const next = f.spoken.at(-1);
  f.advance(45000); assert.equal(f.cancels, 0); assert.equal(f.s.testUtterance, next);
  first.onend({}); f.start(next); f.advance(2000); f.end(next); f.released();
});

test('test with missing start and end releases after observed native busy then stable idle', () => {
  const f = fixture();
  f.s.testSpeech(); const old = f.spoken.at(-1);
  // Androidが開始・終了通知を両方返さなくても、ネイティブキューの状態は変化する。
  f.advance(1000); const oldTimer = [...f.timers.values()][0].fn;
  f.idle(); f.advance(5000);
  f.released(); assert.equal(f.cancels, 0);
  f.s.testSpeech(); const next = f.spoken.at(-1);
  assert.equal(f.spoken.length, 2);
  const newTimer = f.s.watchdogs.get(next);
  oldTimer(); assert.equal(f.s.watchdogs.get(next), newTimer); assert.equal(f.timers.size, 1);
  old.onstart({}); old.onerror({ error: 'interrupted' }); old.onend({});
  assert.equal(f.s.testUtterance, next); assert.equal(f.cancels, 0);
  f.start(); f.advance(2000); f.end(); f.released();
});

test('test captures native busy immediately after speak even if it ends before first poll', () => {
  const f = fixture();
  f.s.testSpeech(); // speak()から戻った時点ではpending=true。
  f.advance(100); f.idle(); // 最初の500ms監視前に空になり、開始・終了通知も欠落。
  f.advance(5000); f.released();
  assert.equal(f.cancels, 0);
  f.s.testSpeech(); assert.equal(f.spoken.length, 2);
  f.start(); f.advance(2000); f.end(); f.released();
});

test('busy seen only inside synchronous onstart remains available after watcher replacement', () => {
  const f = fixture();
  f.synth.speak = u => {
    f.spoken.push(u); f.synth.speaking = true; u.onstart({}); f.synth.speaking = false;
  };
  f.s.testSpeech(); f.advance(5000); f.released(); assert.equal(f.cancels, 0);
});

test('ordinary referee calls retain their original missing-start watchdog behavior', () => {
  const f = fixture();
  f.s.speak('プレー。あなたのサーブです。'); f.advance(1000); f.idle(); f.advance(5000);
  assert.equal(f.s.utterances.size, 1); assert.equal(f.s.testUtterance, null);
  assert.equal(f.cancels, 0); assert.equal(f.s.watchdogs.size, 1);
  f.advance(24000); f.released(); assert.equal(f.cancels, 1);
  assert.equal(f.s.getDiagnostics().find(e => e.type === 'speech-timeout').category, 'start-not-received');
});

test('test idle recovery does not cancel a later active referee call or alter call text/order', () => {
  const f = fixture();
  f.s.testSpeech(); f.advance(1000);
  f.s.speak('プレー。あなたのサーブです。'); const referee = f.spoken.at(-1);
  f.start(referee); f.advance(5000);
  assert.equal(f.cancels, 0); assert.ok(f.s.utterances.has(referee));
  f.end(referee); f.advance(1500); f.released();
  for (const text of ['ポイント。1対0。', 'プレー。相手のサーブです。']) {
    f.s.speak(text); assert.equal(f.spoken.at(-1).text, text);
    f.start(); f.advance(2000); f.end(); f.released();
  }
  assert.equal(f.cancels, 0);
  assert.deepEqual(f.spoken.map(u => u.text), ['音声案内のテストです。',
    'プレー。あなたのサーブです。', 'ポイント。1対0。', 'プレー。相手のサーブです。']);
});

test('screen-reader test repetitions preserve mode, ordered announcements, settings and native-call count', () => {
  const f = fixture(); f.s.setSpeechMode('screen-reader'); f.s.setSpeechRate(1.7);
  const saved = JSON.stringify(f.writes), cancels = f.cancels;
  for (let i = 0; i < 5; i++) {
    f.s.testSpeech(); f.advance(50);
    assert.equal(f.announcer.textContent, '音声案内のテストです。');
    f.advance(1500); assert.equal(f.timers.size, 0);
  }
  f.s.speak('プレー。あなたのサーブです。'); f.advance(50);
  assert.equal(f.announcer.textContent, 'プレー。あなたのサーブです。');
  f.advance(2000); assert.equal(f.timers.size, 0);
  assert.equal(f.s.speechMode, 'screen-reader'); assert.equal(f.s.speechRate, 1.7);
  assert.equal(f.spoken.length, 0); assert.equal(f.cancels, cancels);
  assert.equal(f.s.testUtterance, null); assert.equal(JSON.stringify(f.writes), saved);
});
