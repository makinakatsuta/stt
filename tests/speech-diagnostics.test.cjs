const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture({ unavailable = false, cancelThrows = false, sticky = false } = {}) {
  const spoken = [], timers = new Map(), writes = [];
  let nextTimer = 0, cancels = 0;
  const voice = { name: '端末日本語', lang: 'ja-JP', default: true, localService: true, voiceURI: 'ja' };
  const synth = { speaking: false, pending: false, paused: false,
    getVoices: () => [voice],
    speak(u) { spoken.push(u); this.pending = true; },
    cancel() { cancels++; if (cancelThrows) throw Error('cancel failure'); if (!sticky) this.speaking = this.pending = false; },
    resume() { this.paused = false; }
  };
  const ctx = vm.createContext({ window: { speechSynthesis: unavailable ? null : synth,
    navigator: { userAgent: 'Android Chrome mock' }, location: { href: 'http://localhost/speech-diagnostics.html' } },
    document: { getElementById: () => null }, SpeechSynthesisUtterance: function(text) { this.text = text; },
    readSetting: key => ({ stt_speech_mode: 'screen-reader', stt_speech_rate: '1.7' }[key] ?? null),
    writeSetting: (...args) => writes.push(args), console: { debug() {}, warn() {} },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const speech = fs.readFileSync('docs/js/speech-system.js', 'utf8').replace(/^import .*;\r?\n/gm, '')
    .replace('export class', 'class').replace('export const', 'const');
  const diag = fs.readFileSync('docs/js/speech-diagnostics.js', 'utf8').replace(/^import .*;\r?\n/gm, '')
    .replace('export class', 'class');
  vm.runInContext(speech + '\n' + diag + '\nglobalThis.diag = new SpeechDiagnostics(narrator);', ctx);
  const d = ctx.diag;
  const report = () => JSON.parse(d.report('TalkBack off').split('\n').slice(1).join('\n'));
  return { d, synth, spoken, timers, writes, report, ctx, get cancels() { return cancels; } };
}

test('diagnostic is opt-in, isolated from stored screen-reader mode and speed', () => {
  const f = fixture(); f.d.run('A'); assert.equal(f.spoken.length, 0);
  f.d.start(); f.d.start();
  assert.equal(f.d.speech.speechMode, 'builtin');
  assert.equal(f.report().metadata.savedSpeechMode, 'screen-reader');
  assert.equal(f.report().metadata.rate, 1.7);
  assert.deepEqual(f.writes, []);
});

test('five A and five B tests record all required events, voice, rate and per-test results', () => {
  const f = fixture(); f.d.start();
  for (const kind of ['A', 'B']) for (let i = 0; i < 5; i++) {
    f.d.run(kind); const u = f.spoken.at(-1);
    assert.equal(u.rate, 1.7); assert.equal(u.voice.name, '端末日本語');
    assert.equal(u.lang, 'ja-JP'); assert.equal(u.text, '音声案内のテストです。');
    f.synth.speaking = true; f.synth.pending = false; u.onstart({ charIndex: 0 });
    f.synth.speaking = false; u.onend({ charIndex: 13, elapsedTime: 2 });
    assert.equal(f.timers.size, 0);
    f.d.observe(f.d.tests.length, 'complete', '全文聴取（モック）');
  }
  const r = f.report(); assert.equal(r.tests.length, 10);
  for (const t of r.tests) {
    assert.equal(t.buttonPressed, true); assert.equal(t.speakCalls, 1);
    assert.equal(t.speakReturned, 1); assert.equal(t.onstart, 1); assert.equal(t.onend, 1);
    assert.equal(t.onerror, 0); assert.equal(t.heard, 'complete');
  }
  for (const e of r.events) for (const key of ['speaking', 'pending', 'paused', 'testUtteranceRemaining', 'testUtteranceId', 'testId', 'testKind']) {
    assert.ok(key in e, `${e.type}: ${key}`);
  }
  assert.equal(r.events.filter(e => e.type === 'stop').length, 5);
  assert.equal(r.events.filter(e => e.type === 'cancel-called').length, 5);
  assert.deepEqual(f.writes, []);
});

test('B has no watchdog, resume or retry; missing events remain visible until explicit stop', () => {
  const f = fixture(); f.d.start(); f.synth.paused = true;
  f.d.run('B'); assert.equal(f.timers.size, 0); assert.equal(f.synth.paused, true);
  assert.equal(f.spoken.length, 1); assert.equal(f.report().current.directUtteranceRemaining, true);
  assert.equal(f.report().tests[0].onstart, 0);
  f.d.record('manual-state-snapshot'); f.d.stop();
  assert.equal(f.report().current.directUtteranceRemaining, false);
  assert.equal(f.spoken.length, 1); assert.equal(f.timers.size, 0);
});

test('switches clear A watchdogs and retained references; late A/B events keep original ids', () => {
  const f = fixture(); f.d.start(); f.d.run('A'); const a = f.spoken.at(-1);
  assert.ok(f.timers.size > 0); f.d.run('B'); const b = f.spoken.at(-1);
  assert.equal(f.timers.size, 0); assert.equal(f.d.speech.testUtterance, null);
  a.onerror({ error: 'interrupted' }); assert.equal(f.d.directUtterance, b);
  f.d.run('A'); const next = f.spoken.at(-1);
  b.onend({}); assert.equal(f.d.speech.testUtterance, next);
  assert.equal(f.report().tests[0].onerror, 1); assert.equal(f.report().tests[1].onend, 1);
  assert.equal(f.report().tests[2].onend, 0);
  assert.equal(f.d.directUtterance, null); f.d.stop(); assert.equal(f.timers.size, 0);
});

test('repeated A preserves the normal button guard without hiding retained references through cancel', () => {
  const f = fixture(); f.d.start(); f.d.run('A'); f.d.run('A');
  const button = f.report().events.filter(e => e.type === 'test-button').at(-1);
  assert.equal(button.testUtteranceRemaining, true); assert.equal(button.testUtteranceId, 1);
  assert.equal(f.report().events.filter(e => e.type === 'stop').length, 0);
  assert.equal(f.report().tests[1].rejected[0].reason, 'test-utterance-remains');
  assert.equal(f.spoken.length, 1); assert.equal(f.cancels, 0);
});

for (const [options, reason] of [[{ unavailable: true }, 'web-speech-api-unavailable'],
  [{ cancelThrows: true }, 'previous-cancel-failed'], [{ sticky: true }, 'native-queue-still-busy-after-cancel']]) {
  test(`rejection is recorded: ${reason}`, () => {
    const f = fixture(options); f.d.start(); if (options.sticky) f.synth.pending = true;
    f.d.run('B'); assert.equal(f.spoken.length, 0);
    assert.equal(f.report().tests[0].rejected[0].reason, reason);
    assert.equal(f.report().tests[0].buttonPressed, true);
  });
}

test('API exceptions and errors recorded without retries or loss beyond 100 recent entries', () => {
  const f = fixture(); f.d.start();
  f.synth.speak = () => { throw Error('engine failure'); }; f.d.run('B');
  assert.equal(f.d.directUtterance, null); assert.equal(f.report().tests[0].speakReturned, 0);
  assert.ok(f.report().events.some(e => e.type === 'speak-exception'));
  f.synth.speak = u => f.spoken.push(u); f.d.run('B');
  f.spoken.at(-1).onerror({ error: 'synthesis-failed' });
  assert.equal(f.report().tests[1].onerror, 1); assert.equal(f.d.directUtterance, null);
  for (let i = 0; i < 120; i++) f.d.record('manual-state-snapshot');
  assert.equal(f.d.speech.getDiagnostics().length, 100);
  assert.equal(f.report().tests[0].buttonPressed, true);
  assert.ok(f.report().events.length > 120); assert.equal(f.timers.size, 0);
});
