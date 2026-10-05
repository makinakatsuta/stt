const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let now = 0, nextId = 0, cancels = 0;
const timers = new Map(), spoken = [], stored = {}, updates = [];
const announcer = { set textContent(text) { updates.push(text); }, get textContent() { return updates.at(-1); } };
const context = vm.createContext({ window: { speechSynthesis: {
  getVoices: () => [], cancel: () => cancels++, speak: utterance => spoken.push(utterance)
} }, document: { getElementById: id => id === 'sr-announcer' ? announcer : null },
SpeechSynthesisUtterance: function(text) { this.text = text; },
readSetting: key => stored[key] ?? null, writeSetting: (key, value) => stored[key] = value,
setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
clearTimeout: id => timers.delete(id), console });
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
s.setSpeechRate(1.5); assert.equal(stored.stt_speech_rate, 1.5);
s.speak('エラー時の通知'); spoken.at(-1).onerror({error:'not-allowed'}); advance(50);
assert.equal(announcer.textContent, 'エラー時の通知');
s.stop();
spoken.at(-1).onerror({error:'not-allowed'}); advance(5000);
assert.equal(announcer.textContent, '');
console.log('Passed built-in queuing, polite notification order, explicit stop, fallback and saved settings.');
