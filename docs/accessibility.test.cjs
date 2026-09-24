const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = name => fs.readFileSync(__dirname + '/js/' + name, 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');

function environment({ pointer = true, savedMode, noSpeech = false, denied = false } = {}) {
  const elements = new Map(), timers = new Map(), spoken = [], handlers = {};
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
  const synth = { getVoices: () => [], cancel() {}, speak: utterance => spoken.push(utterance.text) };
  const context = { console, Date, Math, navigator: { userAgent: 'test', maxTouchPoints: 0 },
    localStorage: { getItem(key) { if (denied) throw Error('denied'); return saved.get(key) ?? null; },
      setItem(key, value) { if (denied) throw Error('denied'); saved.set(key, value); } },
    window: { speechSynthesis: noSpeech ? undefined : synth, PointerEvent: pointer ? function() {} : undefined,
      addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { getElementById: element, addEventListener: (type, fn) => { handlers[type] = fn; },
      querySelectorAll: () => [element('select-paused-speech-mode'), element('btn-cancel-quit'), element('btn-quit-hard')] },
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id),
    NetworkSystem: class {}, sounds: new Proxy({}, { get: () => () => {} }) };
  const source = read('settings-storage.js') + '\n' + read('speech-system.js') + '\n'
    + read('constants.js') + '\n' + read('game-engine.js');
  const { game, narrator } = vm.runInNewContext(source + '\n({ game: new GameEngine(), narrator })', context);
  element('screen-help').classList.add('hidden');
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  const event = (target, extra = {}) => ({ target, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
  return { game, narrator, element, handlers, saved, spoken, timers, flush, event, context };
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
