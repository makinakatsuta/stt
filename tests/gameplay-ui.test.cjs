const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('docs/index.html', 'utf8');
const css = fs.readFileSync('docs/styles.css', 'utf8');
const elements = new Map();
const document = { getElementById: id => elements.get(id) || null };
for (const id of ['game-header', 'game-footer', 'canvas-container', 'serve-selection', 'btn-serve-1',
  'btn-serve-2', 'btn-serve-3', 'btn-quit-game', 'btn-calibrate-tilt']) {
  const attrs = new Map(), classes = new Set();
  elements.set(id, { hidden: false, disabled: false, attrs, textContent: '', focus() {},
    classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
      contains: name => classes.has(name) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) });
}
let calls = 0;
const context = vm.createContext({ document, Date, narrator: { speak(text) {
  calls++;
  assert.match(text, /プレー/);
  assert.equal(elements.get('serve-selection').hidden, true, 'hide selection before play');
} } });
vm.runInContext(fs.readFileSync('docs/js/constants.js', 'utf8').replace(/export \{[^}]+\};/, '') + '\n' +
  fs.readFileSync('docs/js/game-engine.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') +
  '\nglobalThis.Engine = GameEngine;', context);
const g = Object.create(context.Engine.prototype);
Object.assign(g, { state: 'SERVE_SELECT', mode: 'online', role: 1, serverRole: 1,
  selectedServeType: 2, isMobile: true, useTilt: true });
const pause = elements.get('btn-quit-game');
g.updateActionButton();

for (const n of [1, 2, 3]) assert.equal(elements.get('btn-serve-' + n).disabled, false);
assert.equal(elements.get('serve-selection').hidden, false);
assert.equal(pause.hidden, false); assert.equal(pause.disabled, false);
g.beginServicePlay('サーブ2。');
assert.equal(calls, 1);
for (const state of ['PRE_SERVE_READY', 'PRE_SERVE_HEARD', 'SERVE_WAITING', 'RALLY', 'POINT_WON']) {
  g.state = state; g.updateActionButton();
  assert.equal(elements.get('serve-selection').hidden, true);
  assert.equal(elements.get('canvas-container').attrs.has('inert'), false);
  assert.equal(elements.get('canvas-container').attrs.has('tabindex'), false);
  for (const n of [1, 2, 3]) assert.equal(elements.get('btn-serve-' + n).disabled, true);
  assert.equal(pause.hidden, false); assert.equal(pause.disabled, false);

}
assert.equal(calls, 1, 'UI updates do not repeat announcements');
assert.ok(!html.includes('btn-game-action'));
const areaTag = html.match(/<div[^>]*id="canvas-container"[^>]*>/)[0];
assert.doesNotMatch(areaTag, /role="button"|aria-label=|tabindex="0"/);
assert.ok(!html.includes('>サーブ・返球</button>'));
// Waiting for an online opponent also exposes no premature action button.
g.serverRole = 2; g.state = 'SERVE_SELECT'; g.updateActionButton();
assert.equal(elements.get('serve-selection').hidden, true);
const playMarkup = html.slice(html.indexOf('<section id="screen-play"'), html.indexOf('<div id="quit-confirm-overlay"'));
assert.ok(!playMarkup.includes('btn-calibrate-tilt'), 'reset is available inside pause menu only');
assert.equal(pause.hidden, false);
// Links stay visually available, but cannot be browsed/tabbed during play.
for (const hidden of [true, false, true, false]) {
  g.setGameplayChromeHidden(hidden);
  for (const id of ['game-header', 'game-footer']) {
    const e = elements.get(id);
    assert.equal(e.attrs.has('inert'), hidden);
    assert.equal(e.attrs.get('aria-hidden'), hidden ? 'true' : undefined);
  }
}
g.screens = Object.fromEntries(['play', 'menu', 'help'].map(id => [id, {
  classList: { add() {}, remove() {} }, querySelector: () => null
}]));
for (const screen of ['play', 'help', 'play', 'menu']) {
  g.changeScreen(screen);
  assert.equal(elements.get('game-footer').attrs.has('inert'), screen === 'play');
}
assert.match(css, /\.hidden\s*\{\s*display:\s*none\s*!important/);
for (const id of ['game-header', 'game-footer']) assert.ok(html.includes('id="' + id + '"'));
for (const n of [1, 2, 3]) assert.match(html, new RegExp('<button[^>]*id="btn-serve-' + n + '"[^>]*type="button"'));
assert.match(html, /<button[^>]*id="btn-quit-game"[^>]*>中断メニュー<\/button>/);
assert.match(html, /id="sr-announcer"[^>]*aria-live="polite"/);
console.log('Passed state-specific native controls, play/focus order, pause access and reversible chrome isolation.');
