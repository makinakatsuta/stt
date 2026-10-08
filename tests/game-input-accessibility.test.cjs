const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('docs/js/game-engine.js', 'utf8');
const html = fs.readFileSync('docs/index.html', 'utf8');
const listeners = new Map();
const documentListeners = new Map();
const attributes = new Map();
let now = 1000;
let focusCount = 0, labelChanges = 0, actions = 0, speech = 0;
const court = {
  style: {}, closest: () => null,
  addEventListener: (type, callback) => listeners.set(type, callback),
  getAttribute: name => attributes.get(name),
  setAttribute: (name, value) => { labelChanges++; attributes.set(name, value); },
  focus: () => focusCount++
};
const quitButton = { id: 'btn-quit-game', closest() { return this; } };
const play = { style: {}, addEventListener: (type, callback) => listeners.set(type, callback), contains: target => [court, play, quitButton].includes(target),
  classList: { contains: () => false, remove() {}, add() {} },
  querySelector() { throw Error('Must focus the court directly'); } };
const help = { classList: { contains: () => true, add() {} } };
const context = vm.createContext({
  document: { getElementById: id => id === 'screen-play' ? play : id === 'btn-test-speech' ? null : court,
    addEventListener: (type, callback) => documentListeners.set(type, callback) },
  window: { PointerEvent: function() {} }, Date: { now: () => now }, Math,
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
assert.equal(play.style.touchAction, 'pan-y pinch-zoom', 'allow scrolling and pinch zoom in long game screens');
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
// Native pause controls retain their keyboard activation.
const buttonSpace = event(quitButton, { code: 'Space', key: ' ' });
documentListeners.get('keydown')(buttonSpace);
assert.equal(buttonSpace.prevented, false);
assert.equal(actions, 1);

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
documentListeners.get('click')(event(court, { detail: 0 }));
assert.equal(actions, 2, 'pointer tap and AT-style compatibility click are deduplicated');
now += 600;
// AT double-tap generates a click without pointer events in many browsers.
documentListeners.get('click')(event(court, { detail: 0 }));
assert.equal(actions, 3);
documentListeners.get('click')(event(quitButton, { detail: 0 }));
documentListeners.get('click')(event({ closest: () => null }, { detail: 0 }));
assert.equal(actions, 3);
now += 600;
documentListeners.get('click')(event(play, { detail: 1 }));
assert.equal(actions, 4, 'ordinary click anywhere in game screen');
actions--;
// Movement gestures and paused-game activation remain ignored.
const beforeScroll = actions;
listeners.get('pointerdown')(event());
listeners.get('pointercancel')(event());
listeners.get('pointerup')(event());
documentListeners.get('click')(event(court, { detail: 1 }));
assert.equal(actions, beforeScroll, 'browser scrolling cancels a tap without a game action');
listeners.get('pointerdown')(event());
listeners.get('pointerup')(event(court, { clientX: 60 }));
assert.equal(actions, 3);
game.isGameplayPaused = true;
documentListeners.get('click')(event(court, { detail: 0 }));
assert.equal(actions, 3);
game.isGameplayPaused = false;
// Space serves on keydown, independent of hold duration.
game.state = state('STATE_SERVE_WAITING');
documentListeners.get('keydown')(event(court, { code: 'Space', key: ' ' }));
assert.equal(game.isCharging, undefined);
assert.equal(actions, 4);
documentListeners.get('keyup')(event(court, { code: 'Space', key: ' ' }));
assert.equal(actions, 4);
documentListeners.get('keydown')(event(court, { code: 'Space', key: ' ', repeat: true }));
assert.equal(actions, 4);
listeners.get('pointerdown')(event());
listeners.get('pointerup')(event());
assert.equal(actions, 5);
assert.equal(game.isCharging, undefined);
// No accessible court naming or forced focus; release the old menu control.
function method(name, end) {
  const start = source.indexOf('  ' + name + '(');
  return vm.runInContext('({' + source.slice(start, source.indexOf(end, start)) + '})', context)[name];
}
assert.ok(!source.includes("setAttribute('aria-label', 'プレイ領域')"));
assert.ok(!source.includes("getElementById('canvas-container').focus()"));
assert.ok(!source.includes("getElementById('canvas-container')?.focus()"));
assert.equal(labelChanges, 0);
const changeScreen = method('changeScreen', '\n  openHelp(');
let blurCount = 0;
context.document.body = { closest: () => null };
context.document.activeElement = { blur() {
  blurCount++;
  context.document.activeElement = context.document.body;
} };
changeScreen.call({ screens: { play }, setGameplayChromeHidden() {}, updateActionButton() {} }, 'play');
assert.equal(focusCount, 0);
assert.equal(blurCount, 1);
const afterMenu = actions;
documentListeners.get('keydown')(event(context.document.activeElement, { code: 'Space', key: ' ' }));
assert.equal(actions, afterMenu + 1, 'Space works after leaving a menu control');
assert.equal(speech, 0);
const resume = method('resumeGameplay', '\n  /**');
court.classList = { add() {} };
context.document.activeElement = { blur() {
  blurCount++;
  context.document.activeElement = context.document.body;
} };
resume.call({ isGameplayPaused: true, gameplayPausedAt: now - 250,
  state: state('STATE_PRE_SERVE_READY'), stateStartTime: 100, gameStartTime: 0,
  startLoop() {}, resumeGameplayTasks() {} });
assert.equal(blurCount, 2, 'resume releases the old pause control');
assert.equal(focusCount, 0, 'resume never focuses the game area');
const afterResume = actions;
documentListeners.get('keydown')(event(context.document.activeElement, { code: 'Space', key: ' ' }));
assert.equal(actions, afterResume + 1, 'Space works after resuming');
assert.equal((html.match(/role="application"/g) || []).length, 1);
assert.ok(html.match(/id="game-canvas"[^>]*aria-hidden="true"/));
assert.ok(!html.match(/id="sr-announcer"[^>]*aria-hidden/));
// Legacy touch fallback also accepts a tap and preserves drag detection.
context.window.PointerEvent = undefined;
bind('    const screenPlay =', '    // 1. オーディオ有効化ボタン');
let before = actions;
documentListeners.get('touchstart')(event(court, { touches: [{ clientX: 20, clientY: 20 }] }));
documentListeners.get('touchend')(event(court, { changedTouches: [{ clientX: 20, clientY: 20 }] }));
assert.equal(actions, before + 1);
documentListeners.get('click')(event(court, { detail: 1 }));
assert.equal(actions, before + 1, 'touchend plus synthetic click only acts once');
assert.equal(game.isCharging, undefined);
documentListeners.get('touchstart')(event(court, { touches: [{ clientX: 20, clientY: 20 }] }));
documentListeners.get('touchend')(event(court, { changedTouches: [{ clientX: 80, clientY: 20 }] }));
assert.equal(actions, before + 1);
console.log('Passed quiet gameplay input without court role/name/focus, taps, AT clicks and preserved controls.');

now += 600;
const count = actions;
for (const input of ['pointerdown', 'pointerup']) listeners.get(input)(event(quitButton));
documentListeners.get('touchend')(event(quitButton, { changedTouches: [{ clientX: 20, clientY: 20 }] }));
assert.equal(actions, count, 'pause control never triggers pointer/touch game input');
game.state = state('STATE_SERVE_SELECT');
documentListeners.get('click')(event(court, { detail: 0 }));
listeners.get('pointerdown')(event()); listeners.get('pointerup')(event());
assert.equal(actions, count, 'play taps do not advance serve selection');
game.state = state('STATE_RALLY');
documentListeners.get('touchend')(event({closest: () => null}, {changedTouches:[{clientX:20,clientY:20}]}));
assert.equal(actions, count, 'outside game cannot trigger legacy touch');
assert.ok(!html.includes('btn-game-action'));
const areaTag = html.match(/<div[^>]*id="canvas-container"[^>]*>/)[0];
assert.doesNotMatch(areaTag, /role="button"|aria-label=|tabindex="0"/);
assert.ok(!html.includes('>サーブ・返球</button>'));

now += 600;
let previous = actions;
documentListeners.get('click')(event(court, {detail:0}));
assert.equal(actions, previous + 1, 'TalkBack click uses common action');
previous = actions;
documentListeners.get('click')(event(court, {detail:0}));
assert.equal(actions, previous + 1, 'VoiceOver click uses same common action');
