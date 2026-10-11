const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let now = 0, nextId = 0, cancels = 0, resumes = 0, voices = [];
const timers = new Map(), spoken = [], stored = {}, updates = [];
const announcer = { set textContent(text) { updates.push(text); }, get textContent() { return updates.at(-1); } };
const context = vm.createContext({ window: { speechSynthesis: {
  getVoices: () => voices, cancel: () => cancels++, speak: utterance => spoken.push(utterance),
  resume: () => { resumes++; context.window.speechSynthesis.paused = false; }
} }, document: { getElementById: id => id === 'sr-announcer' ? announcer : null },
SpeechSynthesisUtterance: function(text) { this.text = text; },
readSetting: key => stored[key] ?? null, writeSetting: (key, value) => stored[key] = value,
setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
clearTimeout: id => timers.delete(id), Date: { now: () => now }, console: { ...console, debug() {} } });
vm.runInContext(fs.readFileSync('docs/js/speech-system.js', 'utf8').replace(/^import .*;\r?\n/gm, '')
  .replace('export class', 'class').replace('export const narrator', 'const narrator') + '\nglobalThis.speech = narrator;', context);
const s = context.speech;
function advance(ms) {
  const target = now + ms;
  while (true) {
    const next = [...timers].filter(([, t]) => t.at <= target).sort((a,b) => a[1].at-b[1].at)[0];
    if (!next) break;
    now = next[1].at; timers.delete(next[0]); next[1].fn();
  }
  now = target;
}
s.speak('難易度、普通でCPU対戦を開始します。');
s.speak('プレー。あなたのサーブです。');
assert.equal(cancels, 0);
assert.equal(spoken.length, 2);
assert.equal(updates.length, 0);
s.stop();
assert.equal(cancels, 1);
assert.equal(s.utterances.size, 0);
s.setSpeechMode('screen-reader');
assert.equal(stored.stt_speech_mode, 'screen-reader');
s.speak('開始案内'); advance(50);
s.speak('プレー');
assert.equal(announcer.textContent, '開始案内');
advance(1200 + 50);
assert.equal(announcer.textContent, 'プレー');
s.speak('得点'); s.speak('反則'); s.speak('ゲーム終了');
advance(10000);
assert.deepEqual(updates.filter(t => ['得点', '反則', 'ゲーム終了'].includes(t)), ['得点', '反則', 'ゲーム終了']);
s.speak('同じ案内'); s.speak('同じ案内'); advance(5000);
assert.equal(updates.filter(t => t === '同じ案内').length, 2);
s.speak('得点'); s.speak('終了'); s.stop(); advance(10000);
assert.equal(announcer.textContent, '');
assert.equal(timers.size, 0);
s.speak('音声案内のテストです。'); advance(50);
assert.equal(updates.filter(t => t === '音声案内のテストです。').length, 1);
assert.equal(spoken.length, 2);
s.setSpeechMode('builtin');
assert.equal(stored.stt_speech_mode, 'builtin');
assert.equal(vm.runInContext('new SpeechSystem().speechMode', context), 'builtin');
assert.equal(timers.size, 0);
s.setSpeechMode('invalid'); assert.equal(stored.stt_speech_mode, 'builtin');
s.setSpeechRate(1.5); assert.equal(stored.stt_speech_rate, '1.5');
for (const [input, expected] of [[0.1, 0.5], [3, 2], [1.26, 1.3], [NaN, 1.2], [Infinity, 1.2]]) {
  s.setSpeechRate(input);
  assert.equal(s.speechRate, expected);
  assert.equal(stored.stt_speech_rate, expected.toFixed(1));
  assert.equal(vm.runInContext('new SpeechSystem().speechRate', context), expected);
}
s.setSpeechMode('screen-reader');
s.setSpeechRate(1.7);
assert.equal(stored.stt_speech_rate, '1.7');
const spokenBefore = spoken.length;
s.speak('速度設定後のスクリーンリーダー案内'); advance(50);
assert.equal(spoken.length, spokenBefore);
assert.equal(announcer.textContent, '速度設定後のスクリーンリーダー案内');
s.setSpeechMode('builtin');
s.speak('設定速度の内蔵音声');
assert.equal(spoken.at(-1).rate, 1.7);

s.speak('エラー時の通知'); spoken.at(-1).onerror({error:'not-allowed'}); advance(50);
assert.equal(announcer.textContent, '');
assert.equal(s.speechMode, 'builtin');
s.stop();
spoken.at(-1).onerror({error:'not-allowed'}); advance(5000);
assert.equal(announcer.textContent, '');
const google = { name: 'Google 日本語', lang: 'ja-JP', default: false, localService: false, voiceURI: 'google-ja' };
const local = { name: '端末日本語', lang: 'ja-JP', default: true, localService: true, voiceURI: 'local-ja' };
voices = [google, local];
s.loadVoice(); assert.equal(s.voice, google); // PCの既存選択を維持。
context.window.navigator = { userAgent: 'Android Chrome' };
const android = vm.runInContext('new SpeechSystem()', context);
assert.equal(android.getDiagnostics().length, 0);
android.setDiagnosticsEnabled(true);
assert.equal(android.voice, local);
voices = [google, { name: 'English', lang: 'en-US', default: true }];
android.loadVoice(); assert.equal(android.voice, null);
voices = []; android.loadVoice(); assert.equal(android.voice, null);
android.testSpeech(); assert.equal(spoken.at(-1).voice, undefined);
assert.equal(spoken.at(-1).lang, 'ja-JP'); spoken.at(-1).onend({});
voices = [google, local]; context.window.speechSynthesis.onvoiceschanged();
assert.equal(android.voice, local);
context.window.navigator.userAgent = 'iPhone';
assert.equal(vm.runInContext('new SpeechSystem().voice', context), google);
android.setSpeechRate(1);
context.window.speechSynthesis.paused = true;
android.testSpeech();
assert.equal(resumes, 1);
const test = spoken.at(-1), before = spoken.length, beforeCancel = cancels;
assert.equal(test.rate, 1); assert.equal(test.voice, local);
android.testSpeech(); assert.equal(spoken.length, before); assert.equal(cancels, beforeCancel);
test.onstart({ charIndex: 0, elapsedTime: 0 }); advance(150);
test.onend({ charIndex: 0, elapsedTime: 0.15 });
assert.equal(android.getDiagnostics().at(-1).category, 'possible-early-end');
assert.equal(android.testUtterance, null); assert.equal(timers.size, 0);
advance(60000); assert.equal(spoken.length, before); // 早い終了でも自動再発声しない。
for (const error of ['interrupted', 'canceled', 'synthesis-failed', 'voice-unavailable', 'not-allowed', 'audio-hardware']) {
  android.testSpeech(); const u = spoken.at(-1), count = spoken.length;
  u.onerror({ error }); u.onerror({ error }); advance(60000);
  assert.equal(spoken.length, count); assert.equal(android.testUtterance, null);
  assert.equal(android.getDiagnostics().filter(e => e.type === 'error').at(-1).category,
    ['interrupted', 'canceled'].includes(error) ? 'queue-interruption' : 'engine-error');
  assert.equal(announcer.textContent, ''); assert.equal(android.speechMode, 'builtin');
}
android.testSpeech(); const stopped = spoken.at(-1); android.stop();
stopped.onerror({ error: 'interrupted' });
assert.equal(android.getDiagnostics().at(-1).category, 'explicit-stop');
assert.equal(android.testUtterance, null); assert.equal(timers.size, 0);
android.testSpeech(); advance(30000);
assert.equal(android.getDiagnostics().filter(e => e.type === 'speech-timeout').at(-1).category, 'start-not-received');
assert.equal(android.testUtterance, null); assert.equal(android.utterances.size, 0);
const waitingCount = spoken.length; android.testSpeech(); assert.equal(spoken.length, waitingCount + 1);
spoken.at(-1).onstart({}); context.window.speechSynthesis.paused = true;
android.stop(); context.window.speechSynthesis.paused = false;
android.testSpeech(); spoken.at(-1).onstart({}); advance(30000);
assert.equal(android.getDiagnostics().filter(e => e.type === 'speech-timeout').at(-1).category, 'terminal-event-not-received');
spoken.at(-1).onend({ charIndex: 13, elapsedTime: 30 });
assert.equal(android.getDiagnostics().at(-1).category, 'recovery');
assert.equal(android.utterances.size, 0);
android.testSpeech(); context.window.speechSynthesis.paused = true; advance(30000);
assert.equal(android.getDiagnostics().filter(e => e.type === 'speech-timeout').at(-1).category, 'queue-paused'); android.stop();
context.window.speechSynthesis.paused = false;
const originalSpeak = context.window.speechSynthesis.speak;
context.window.speechSynthesis.speak = () => { throw new Error('engine failure'); };
android.testSpeech(); assert.equal(android.testUtterance, null); assert.equal(android.utterances.size, 0);
assert.equal(timers.size, 0); assert.equal(android.getDiagnostics().filter(e => e.type === 'speak-exception').at(-1).category, 'engine-error');
context.window.speechSynthesis.speak = originalSpeak;
const unavailable = vm.runInContext('new SpeechSystem()', context); unavailable.synth = null;
unavailable.testSpeech(); advance(50); assert.equal(announcer.textContent, '');
android.testSpeech(); const normal = spoken.at(-1); normal.onstart({});
normal.onpause({ charIndex: 2 }); normal.onresume({ charIndex: 2 }); advance(2000);
normal.onend({ charIndex: 13, elapsedTime: 2 });
assert.equal(android.getDiagnostics().at(-1).category, 'end-reported');
assert.ok(android.getDiagnostics().some(e => e.type === 'pause'));
assert.ok(android.getDiagnostics().some(e => e.type === 'resume'));
assert.equal(timers.size, 0);
android.speak('先頭'); android.speak('後続');
const first = spoken.at(-2), second = spoken.at(-1);
first.onstart({}); advance(2000); first.onend({}); second.onstart({}); advance(2000); second.onend({});
assert.equal(android.utterances.size, 0); assert.equal(timers.size, 0);
android.speak('停止する先頭'); android.speak('破棄する古いコール'); advance(30000);
assert.equal(android.utterances.size, 0); assert.equal(timers.size, 0);
android.testSpeech(); spoken.at(-1).onstart({}); advance(2000); spoken.at(-1).onend({});
assert.equal(android.testUtterance, null);
for (let i = 0; i < 110; i++) android.recordSpeech('bounded-log');
assert.equal(android.getDiagnostics().length, 100);
android.getDiagnostics()[0].type = 'modified'; assert.equal(android.getDiagnostics()[0].type, 'bounded-log');
android.setDiagnosticsEnabled(false); android.recordSpeech('disabled'); assert.equal(android.getDiagnostics().length, 0);
assert.equal(updates.filter(t => t === 'エラー時の通知').length, 0);
const originalGetVoices = context.window.speechSynthesis.getVoices;
context.window.speechSynthesis.getVoices = () => { throw new Error('voices unavailable'); };
android.setDiagnosticsEnabled(true); android.testSpeech();
assert.ok(android.getDiagnostics().some(e => e.type === 'voices-error'));
spoken.at(-1).onend({}); android.setDiagnosticsEnabled(false);
context.window.speechSynthesis.getVoices = originalGetVoices;
console.log('Passed builtin queues, unchanged screen-reader order/settings, Android/PC/iOS voice selection, diagnostics, test deduplication, timeout, stop and no automatic fallback/retry.');
