const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = name => fs.readFileSync(__dirname + '/js/' + name, 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const source = read('settings-storage.js') + '\n' + read('constants.js') + '\n' + read('game-engine.js');
function environment(storage) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const events = {};
      elements.set(id, { events, checked: true, style: {}, dataset: {}, value: '',
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle() {} },
        addEventListener: (type, listener) => { events[type] = listener; },
        removeEventListener() {}, setAttribute() {}, getContext: () => ({}), focus() {},
        querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 800, height: 500 }) });
    }
    return elements.get(id);
  }
  const context = { localStorage: storage, navigator: { userAgent: 'test', maxTouchPoints: 0 },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { getElementById: element, addEventListener() {}, querySelectorAll: () => [] },
    NetworkSystem: class {}, sounds: new Proxy({}, { get: () => () => {} }),
    narrator: { speak() {}, stop() {}, setSpeechRate() {} }, console,
    setTimeout: () => 1, clearTimeout() {}, Date, Math };
  const GameEngine = vm.runInNewContext(source + '\nGameEngine', context);
  const game = new GameEngine();
  game.startLoop = () => {}; game.stopLoop = () => {};
  return { game, element };
}
const saved = new Map([['stt_normal_feedback', 'off']]);
const store = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
const first = environment(store);
assert.equal(first.element('normal-feedback').checked, false);
first.element('normal-feedback').checked = true;
first.element('normal-feedback').events.change();
assert.equal(environment(store).element('normal-feedback').checked, true);
const blocked = environment({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
blocked.element('normal-feedback').checked = false;
assert.doesNotThrow(() => blocked.element('normal-feedback').events.change());
for (const difficulty of ['easy', 'normal', 'hard']) {
  blocked.element('btn-diff-' + difficulty).events.click();
  assert.equal(blocked.game.difficulty, difficulty);
  assert.equal(blocked.game.state, 'PRE_SERVE_READY');
  Object.assign(blocked.game.ball, { easyReturnCount: 4, easyCpuAttempted: true, normalCpuAttempted: true, hardCpuAttempted: true });
  blocked.game.showQuitConfirmation();
  assert.equal(blocked.game.isGameplayPaused, true);
  blocked.game.openHelp(); blocked.game.closeHelp();
  assert.equal(blocked.game.isGameplayPaused, true);
  blocked.game.resumeGameplay();
  assert.equal(blocked.game.isGameplayPaused, false);
  assert.equal(blocked.game.ball.easyReturnCount, 4, 'Pause must preserve rally progress');
  blocked.game.startNewMatch();
  assert.equal(blocked.game.ball.easyReturnCount, 0);
  assert.equal(blocked.game.ball.hardCpuAttempted, false);
}
// Complete a game through the real score handler, then start its next serve.
blocked.game.scores = { p1: 10, p2: 0 };
blocked.game.state = 'RALLY';
blocked.game.awardPointTo(1, 'safe');
blocked.game.intervalSkipCallback();
assert.equal(blocked.game.gameScores.p1, 1);
assert.equal(blocked.game.serverRole, 2);
blocked.game.prepareServeSequence();
assert.equal(blocked.game.ball.easyReturnCount, 0);
console.log('Settings save/restore/denial, initialization, difficulty selection, pause/help/resume and game transition passed.');
const deniedContext = { window: {}, document: { getElementById: () => null } };
Object.defineProperty(deniedContext, 'localStorage', { get() { throw new Error('SecurityError'); } });
const speech = vm.runInNewContext(read('settings-storage.js') + '\n' + read('speech-system.js') + '\nnarrator', deniedContext);
assert.equal(speech.speechRate, 1.2);
assert.doesNotThrow(() => speech.setSpeechRate(1.5));
assert.equal(speech.speechRate, 1.5);
console.log('Speech initialization and speed changes survive blocked storage access.');
