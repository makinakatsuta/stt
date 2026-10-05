const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('docs/js/game-engine.js', 'utf8');
const html = fs.readFileSync('docs/index.html', 'utf8');
const listeners = new Map();
const documentListeners = new Map();
const attributes = new Map([['aria-label', 'コート']]);
let focusCount = 0, labelChanges = 0, actions = 0, speech = 0;
const court = {
  style: {}, closest: () => null,
  addEventListener: (type, callback) => listeners.set(type, callback),
  getAttribute: name => attributes.get(name),
  setAttribute: (name, value) => { labelChanges++; attributes.set(name, value); },
  focus: () => focusCount++
};
const actionButton = { id: 'btn-game-action', closest() { return this; } };
const quitButton = { id: 'btn-quit-game', closest() { return this; } };
const play = { contains: target => [court, actionButton, quitButton].includes(target),
  classList: { contains: () => false, remove() {}, add() {} },
  querySelector() { throw Error('Must focus the court directly'); } };
const help = { classList: { contains: () => true, add() {} } };
const context = vm.createContext({
  document: { getElementById: id => id === 'screen-play' ? play : court,
    addEventListener: (type, callback) => documentListeners.set(type, callback) },
  window: { PointerEvent: function() {} }, Date, Math,
  narrator: { speak: () => speech++ }
});
vm.runInContext(fs.readFileSync('docs/js/constants.js', 'utf8').replace(/export \{[^}]+\};/, ''), context);
vm.runInContext(source.match(/    const isControl = .*;/)[0], context);
const state = name => vm.runInContext(name, context);
const game = { state: state('STATE_RALLY'), screens: { play, help }, keys: {},
  handleActionInput: () => actions++, isMyTurnToServe: () => true,
  showQuitConfirmation: () => { game.pauses = (game.pauses || 0) + 1; } };
function bind(start, end) {
  const fragment = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  vm.runInContext('(function(){' + fragment + '\n})', context).call(game);
}
bind('    const screenPlay =', '    // 1. オーディオ有効化ボタン');
bind("    document.addEventListener('keydown'", '    // ウィンドウ切り替え');
function event(target = court, props = {}) {
  return { target, isPrimary: true, pointerId: 1, clientX: 20, clientY: 20,
    prevented: false, preventDefault() { this.prevented = true; }, ...props };
}
for (const code of ['ArrowLeft', 'ArrowRight']) {
  const down = event(court, { code, key: code });
  documentListeners.get('keydown')(down);
  assert.equal(down.prevented, true);
  assert.equal(game.keys[code], true);
  documentListeners.get('keyup')(event(court, { code, key: code }));
  assert.equal(game.keys[code], false);
}
const space = event(court, { code: 'Space', key: ' ', repeat: false });
documentListeners.get('keydown')(space);
assert.equal(space.prevented, true);
assert.equal(actions, 1);
documentListeners.get('keydown')(event(court, { code: 'Space', key: ' ', repeat: true }));
assert.equal(actions, 1);
const released = event(court, { code: 'Space', key: ' ' });
documentListeners.get('keyup')(released);
assert.equal(released.prevented, true);
// Native action-button Space remains available without a duplicate game action.
const buttonSpace = event(actionButton, { code: 'Space', key: ' ' });
documentListeners.get('keydown')(buttonSpace);
assert.equal(buttonSpace.prevented, false);
assert.equal(actions, 1);
const buttonArrow = event(actionButton, { code: 'ArrowLeft', key: 'ArrowLeft' });
documentListeners.get('keydown')(buttonArrow);
assert.equal(buttonArrow.prevented, true);
documentListeners.get('keydown')(event(court, { code: 'Escape', key: 'Escape' }));
assert.equal(game.pauses, 1);
// Pointer tap plus its compatibility click produces only one action.
const down = event();
listeners.get('pointerdown')(down);
assert.equal(down.prevented, true);
listeners.get('pointerup')(event());
assert.equal(actions, 2);
documentListeners.get('click')(event(court, { detail: 1 }));
assert.equal(actions, 2);
// AT double-tap generates a click without pointer events in many browsers.
documentListeners.get('click')(event(court, { detail: 0 }));
assert.equal(actions, 3);
documentListeners.get('click')(event(quitButton, { detail: 0 }));
documentListeners.get('click')(event({ closest: () => null }, { detail: 0 }));
assert.equal(actions, 3);
// Movement gestures and paused-game activation remain ignored.
listeners.get('pointerdown')(event());
listeners.get('pointerup')(event(court, { clientX: 60 }));
assert.equal(actions, 3);
game.isGameplayPaused = true;
documentListeners.get('click')(event(court, { detail: 0 }));
assert.equal(actions, 3);
game.isGameplayPaused = false;
// Space charging retains press/release behavior on the court.
game.state = state('STATE_SERVE_WAITING');
documentListeners.get('keydown')(event(court, { code: 'Space', key: ' ' }));
assert.equal(game.isCharging, true);
assert.equal(actions, 3);
documentListeners.get('keyup')(event(court, { code: 'Space', key: ' ' }));
assert.equal(actions, 4);
// Extract real methods to check fixed naming and a single initial focus.
function method(name, end) {
  const start = source.indexOf('  ' + name + '(');
  return vm.runInContext('({' + source.slice(start, source.indexOf(end, start)) + '})', context)[name];
}
const updateLabel = method('updateCanvasAriaLabel', '\n  // =====');
for (const isMobile of [true, false]) {
  for (const useTilt of [true, false]) updateLabel.call({ isMobile, useTilt });
}
assert.equal(labelChanges, 0);
const changeScreen = method('changeScreen', '\n  openHelp(');
changeScreen.call({ screens: { play }, updateActionButton() {} }, 'play');
assert.equal(focusCount, 1);
assert.equal(speech, 0);
assert.equal((html.match(/role="application"/g) || []).length, 1);
assert.ok(html.match(/id="game-canvas"[^>]*aria-hidden="true"/));
assert.ok(!html.match(/id="sr-announcer"[^>]*aria-hidden/));
console.log('Passed quiet gameplay input, focus, fixed court name, taps, AT clicks and preserved controls.');
