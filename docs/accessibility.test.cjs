const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = name => fs.readFileSync(__dirname + '/js/' + name, 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');

function environment({ pointer = true, savedMode, noSpeech = false, denied = false } = {}) {
  const elements = new Map(), timers = new Map(), due = new Map(), spoken = [], utterances = [], handlers = {};
  let now = 10000;
  class ClockDate extends Date { static now() { return now; } }
  const saved = new Map(savedMode ? [['stt_speech_mode', savedMode]] : []);
  let nextTimer = 0;
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set(), events = {};
      const tagName = id.startsWith('btn-') ? 'BUTTON' : id.startsWith('select-') ? 'SELECT' : 'DIV';
      elements.set(id, { id, tagName, events, style: {}, dataset: {}, value: '', textContent: '',
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle() {} },
        addEventListener: (type, fn) => { events[type] = fn; }, removeEventListener() {},
        setAttribute() {}, getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 500 }),
        closest() { return ['BUTTON', 'SELECT'].includes(tagName) ? this : null; },
        focus() { context.document.activeElement = this; }, querySelector: () => null, querySelectorAll: () => [] });
    }
    return elements.get(id);
  };
  const synth = { getVoices: () => [], cancel() {}, speak: utterance => { spoken.push(utterance.text); utterances.push(utterance); } };
  const context = { console, Date: ClockDate, Math, navigator: { userAgent: 'test', maxTouchPoints: 0 },
    localStorage: { getItem(key) { if (denied) throw Error('denied'); return saved.get(key) ?? null; },
      setItem(key, value) { if (denied) throw Error('denied'); saved.set(key, value); } },
    window: { speechSynthesis: noSpeech ? undefined : synth, PointerEvent: pointer ? function() {} : undefined,
      addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { getElementById: element, addEventListener: (type, fn) => { handlers[type] = fn; },
      querySelectorAll: () => [element('select-paused-speech-mode'), element('btn-cancel-quit'), element('btn-quit-hard')] },
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    setTimeout(fn, delay = 0) { timers.set(++nextTimer, fn); due.set(nextTimer, now + delay); return nextTimer; },
    clearTimeout(id) { timers.delete(id); due.delete(id); },
    NetworkSystem: class { disconnect() {} }, sounds: new Proxy({}, { get: () => () => {} }) };
  const source = read('settings-storage.js') + '\n' + read('speech-system.js') + '\n'
    + read('constants.js') + '\n' + read('game-engine.js');
  const { game, narrator } = vm.runInNewContext(source + '\n({ game: new GameEngine(), narrator })', context);
  element('screen-help').classList.add('hidden');
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  const advance = ms => {
    const target = now + ms;
    while (true) {
      const next = [...due].filter(([id, time]) => timers.has(id) && time <= target)
        .sort((a, b) => a[1] - b[1])[0];
      if (!next) break;
      now = next[1];
      const fn = timers.get(next[0]);
      timers.delete(next[0]); due.delete(next[0]); fn();
    }
    now = target;
  };
  const event = (target, extra = {}) => ({ target, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
  return { game, narrator, element, handlers, saved, spoken, utterances, timers, flush, advance, event, context };
}

const voice = environment();
voice.narrator.speak('得点'); voice.flush();
assert.deepEqual(voice.spoken, ['得点']);
assert.equal(voice.element('sr-announcer').textContent, '');
assert.match(voice.element('referee-message').textContent, /得点/);
voice.element('select-speech-mode').value = 'screen-reader';
voice.element('select-speech-mode').events.change();
assert.equal(voice.saved.get('stt_speech_mode'), 'screen-reader');
assert.equal(voice.element('select-paused-speech-mode').value, 'screen-reader');
assert.equal(voice.element('range-speech-rate').disabled, true);
voice.narrator.speak('古い案内'); voice.narrator.speak('新しい案内'); voice.flush();
assert.equal(voice.element('sr-announcer').textContent, '新しい案内');
assert.deepEqual(voice.spoken, ['得点']);
voice.narrator.speak('取り消す案内'); voice.narrator.stop(); voice.flush();
assert.equal(voice.element('sr-announcer').textContent, '');
voice.narrator.speak('切り替え前');
voice.element('select-paused-speech-mode').value = 'builtin';
voice.element('select-paused-speech-mode').events.change(); voice.flush();
assert.equal(voice.element('sr-announcer').textContent, '');
assert.equal(voice.element('select-speech-mode').value, 'builtin');
assert.equal(voice.element('range-speech-rate').disabled, false);
assert.equal(environment({ savedMode: 'screen-reader' }).narrator.speechMode, 'screen-reader');
assert.equal(environment({ savedMode: 'invalid' }).narrator.speechMode, 'builtin');
const denied = environment({ denied: true });
assert.doesNotThrow(() => denied.narrator.setSpeechMode('screen-reader'));
assert.equal(denied.narrator.speechMode, 'screen-reader');
const fallback = environment({ noSpeech: true });
fallback.narrator.speak('代替通知'); fallback.flush();
assert.equal(fallback.element('sr-announcer').textContent, '代替通知');

for (const pointer of [true, false]) {
  const env = environment({ pointer });
  const { game, element, handlers, event } = env;
  game.state = 'RALLY';
  let actions = 0;
  game.handleActionInput = () => actions++;
  const button = element('btn-game-action');
  const child = { tagName: 'SPAN', closest: () => button };
  // Native button descendants must not enter either canvas or document tap paths.
  const touch = event(child, { changedTouches: [{ clientX: 0, clientY: 0 }], touches: [{ clientX: 0, clientY: 0 }] });
  handlers.touchstart(touch); handlers.touchend(touch);
  assert.equal(touch.prevented, false);
  const pointerEvent = event(child, { isPrimary: true, pointerId: 1, clientX: 0, clientY: 0 });
  element('canvas-container').events.pointerdown(pointerEvent);
  element('canvas-container').events.pointerup(pointerEvent);
  const click = event(child);
  button.events.click(click);
  if (!click.stopped) handlers.click(click);
  assert.equal(actions, 1, 'A complete tap must execute once');
  // Assistive technology can invoke click with no preceding pointer events.
  button.events.click(event(button, { detail: 0 }));
  assert.equal(actions, 2);
  for (const target of [button, element('btn-quit-game'), element('select-speech-mode')]) {
    const key = event(target, { code: 'Space', key: ' ', repeat: false });
    handlers.keydown(key); handlers.keyup(key);
    assert.equal(key.prevented, false, 'Native Space activation is preserved');
    assert.equal(actions, 2);
  }
  const arrow = event(button, { code: 'ArrowLeft', key: 'ArrowLeft' });
  handlers.keydown(arrow); assert.equal(game.keys.ArrowLeft, true); handlers.keyup(arrow);
  const space = event(element('canvas-container'), { code: 'Space', key: ' ', repeat: false });
  handlers.keydown(space); assert.equal(actions, 3); assert.equal(space.prevented, true);
  game.isGameplayPaused = true;
  button.events.click(event(button)); assert.equal(actions, 3);
  element('select-paused-speech-mode').focus();
  const tab = event(element('select-paused-speech-mode'), { key: 'Tab', shiftKey: true });
  handlers.keydown(tab); assert.equal(env.context.document.activeElement.id, 'btn-quit-hard');
  game.isGameplayPaused = false;
  element('screen-play').classList.add('hidden');
  button.events.click(event(button)); assert.equal(actions, 3);
}
console.log('Accessibility: speech routing/storage/cancellation, native actions, tap deduplication, keyboard and modal focus passed.');

// Exercise the real score handler: no direct live-region writes may bypass routing.
for (const savedMode of ['builtin', 'screen-reader']) {
  for (const reason of ['miss', 'safe', 'stop']) {
    const env = environment({ savedMode });
    env.game.state = 'RALLY';
    env.game.awardPointTo(2, reason);
    env.advance(300);
    const score = env.element('referee-message').textContent;
    assert.match(score, /ポイント CPU。 0 対 1/);
    if (savedMode === 'builtin') assert.equal(env.element('sr-announcer').textContent, '');
    else assert.match(env.element('sr-announcer').textContent, /ポイント CPU。 0 対 1/);
    env.advance(2200);
    if (savedMode === 'builtin') assert.equal(env.element('sr-announcer').textContent, '');
    else assert.match(env.element('sr-announcer').textContent, /ポイント CPU。 0 対 1/);
  }
}

// Preserve the remaining delay through pause, including CPU reply and serve.
for (const phase of ['cpu-ready', 'cpu-reply', 'cpu-serve', 'point', 'next-game']) {
  const env = environment();
  const { game } = env;
  game.startLoop = () => {}; game.stopLoop = () => {};
  game.mode = 'cpu';
  game.serverRole = phase === 'cpu-reply' ? 1 : 2;
  game.prepareServeSequence();
  if (phase === 'cpu-reply') game.handleActionInput();
  if (phase === 'cpu-serve') { env.advance(2000); game.handleActionInput(); }
  if (phase === 'point' || phase === 'next-game') {
    game.clearGameplayTasks(); game.state = 'RALLY';
    if (phase === 'next-game') game.scores.p1 = 10;
    game.awardPointTo(1, 'safe');
    if (phase === 'next-game') game.handleActionInput();
  }
  env.advance(100);
  const task = [...game.gameplayTasks][0];
  assert.ok(task, phase);
  game.showQuitConfirmation();
  const state = game.state, callCount = env.spoken.length;
  env.advance(20000);
  assert.equal(game.state, state, phase + ' must stay paused');
  assert.equal(env.spoken.length, callCount, phase + ' must stay silent');
  game.resumeGameplay();
  const remaining = task.remaining;
  env.advance(remaining - 1);
  assert.equal(game.state, state, phase + ' must preserve remaining time');
  env.advance(1);
  assert.notEqual(game.state, state, phase + ' must continue after resume');
}

for (const action of ['quitGame', 'startNewMatch']) {
  const env = environment();
  env.game.startLoop = () => {}; env.game.stopLoop = () => {};
  let stale = 0;
  env.game.scheduleGameplayTask(() => stale++, 1000);
  env.game[action]();
  env.advance(5000);
  assert.equal(stale, 0, action + ' cancels previous match callbacks');
}
const skip = environment();
skip.game.state = 'RALLY'; skip.game.awardPointTo(1, 'stop');
skip.game.handleActionInput(); skip.advance(300);
assert.equal(skip.spoken.some(text => text.includes('ポイント')), false, 'Skip cancels the delayed old score');

const syncError = environment();
syncError.narrator.synth.speak = () => { throw new Error('Expected test speech failure'); };
syncError.context.console = { ...console, warn() {} };
syncError.narrator.speak('代替の得点案内'); syncError.advance(50);
assert.equal(syncError.element('sr-announcer').textContent, '代替の得点案内');
const asyncError = environment();
asyncError.narrator.speak('発声できなかった案内');
asyncError.utterances[0].onerror({ error: 'synthesis-failed' });
asyncError.advance(50);
assert.equal(asyncError.element('sr-announcer').textContent, '発声できなかった案内');
for (const action of ['stop', 'switch', 'new']) {
  const env = environment();
  env.narrator.speak('古い案内');
  if (action === 'stop') env.narrator.stop();
  if (action === 'switch') env.narrator.setSpeechMode('screen-reader');
  if (action === 'new') env.narrator.speak('新しい案内');
  env.utterances[0].onerror({ error: 'synthesis-failed' }); env.advance(50);
  assert.equal(env.element('sr-announcer').textContent, '', 'Late errors cannot revive old speech');
}
console.log('Accessibility regressions: score routing, paused delays, cancellation and speech error fallback passed.');

const lastPoint = environment();
lastPoint.game.scores.p1 = 10; lastPoint.game.state = 'RALLY';
lastPoint.game.awardPointTo(1, 'stop'); lastPoint.game.handleActionInput(); lastPoint.advance(300);
assert.equal(lastPoint.spoken.some(text => text.includes('ポイント')), false, 'Game transition cancels delayed old score');
for (const action of ['stop', 'switch', 'new']) {
  const env = environment(); env.narrator.speak('保留中の代替通知');
  env.utterances[0].onerror({ error: 'audio-busy' });
  if (action === 'stop') env.narrator.stop();
  if (action === 'switch') env.narrator.setSpeechMode('screen-reader');
  if (action === 'new') env.narrator.speak('次の案内');
  env.advance(50);
  assert.equal(env.element('sr-announcer').textContent, '', 'Pending fallback must be canceled');
}
console.log('Game-transition and pending speech fallback cancellation passed.');
