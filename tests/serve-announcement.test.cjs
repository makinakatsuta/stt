const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const calls = [];
const elements = new Map();
const document = { getElementById(id) {
  if (!elements.has(id)) elements.set(id, { textContent: '', classList: { add() {} } });
  return elements.get(id);
} };
const context = vm.createContext({ document, window: {}, Date, Math,
  sounds: new Proxy({}, { get: () => () => {} }),
  narrator: { speak: (...args) => calls.push(args) }, console });
vm.runInContext(fs.readFileSync('docs/js/constants.js', 'utf8').replace(/export \{[^}]+\};/, '') + '\n' +
  fs.readFileSync('docs/js/game-engine.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') +
  '\nglobalThis.Engine = GameEngine;', context);
function game(mode, role, serverRole) {
  const g = Object.create(context.Engine.prototype);
  Object.assign(g, { mode, role, serverRole, ball: {}, p1: {}, p2: {},
    scores: { p1: 0, p2: 0 }, gameScores: { p1: 0, p2: 0 }, maxScore: 11, matchGames: 3,
    clearGameplayTasks() {}, scheduleGameplayTask() {}, isServerAndDecider: () => false });
  return g;
}
for (const [mode, role, serverRole, name] of [
  ['cpu', 1, 1, 'あなた'], ['cpu', 1, 2, 'CPU'],
  ['online', 1, 1, 'あなた'], ['online', 1, 2, '対戦相手'],
  ['online', 2, 1, '対戦相手'], ['online', 2, 2, 'あなた']
]) {
  calls.length = 0;
  game(mode, role, serverRole).prepareServeSequence();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `プレー。${name}のサーブです。`);
  assert.equal(calls[0][1], true);
  assert.equal(elements.get('current-server').textContent, `現在のサーブ：${name}`);
}
// Exercise the actual point and game transition callbacks, including the
// three-second gap between changing the game server and preparing the serve.
for (const [p1, p2, serverRole, expected] of [[0, 0, 1, 1], [1, 0, 1, 2], [9, 10, 1, 2], [10, 10, 2, 1]]) {
  const g = game('cpu', 1, serverRole);
  g.scores = { p1, p2 };
  g.awardPointTo(1, 'miss');
  g.intervalSkipCallback();
  assert.equal(g.serverRole, expected);
  assert.equal(elements.get('current-server').textContent, `現在のサーブ：${expected === 1 ? 'あなた' : 'CPU'}`);
}
for (const [gamesWon, expected] of [[0, 2], [1, 1]]) {
  const g = game('cpu', 1, 1);
  g.gameScores.p2 = gamesWon;
  g.scores.p1 = 10;
  g.awardPointTo(1, 'miss');
  g.intervalSkipCallback();
  assert.equal(g.serverRole, expected);
  assert.equal(elements.get('current-server').textContent, `現在のサーブ：${expected === 1 ? 'あなた' : 'CPU'}`);
}
console.log('Passed serve announcements, online perspectives, service rotation and game transitions.');
for (const [state, mineLabel, otherLabel] of [
  ['STATE_PRE_SERVE_READY', '『いきます』と伝える', 'CPUの『いきます』を待っています'],
  ['STATE_PRE_SERVE_HEARD', 'CPUの『はい』を待っています', '『はい』と答える'],
  ['STATE_SERVE_WAITING', 'サーブする', 'CPUのサーブを待っています'],
  ['STATE_RALLY', '返球', '返球'],
  ['STATE_POINT_WON', '次のポイントへ', '次のポイントへ'],
  ['STATE_MENU', 'サーブ・返球', 'サーブ・返球']
]) {
  for (const server of [1, 2]) {
    const g = game('cpu', 1, server);
    g.state = vm.runInContext(state, context);
    g.updateActionButton();
    const button = elements.get('btn-game-action');
    assert.equal(button.textContent, server === 1 ? mineLabel : otherLabel);
    assert.equal(button.disabled, undefined);
  }
}
const online = game('online', 2, 1);
online.state = vm.runInContext('STATE_SERVE_WAITING', context);
online.updateActionButton();
assert.equal(elements.get('btn-game-action').textContent, '相手のサーブを待っています');
const html = fs.readFileSync('docs/index.html', 'utf8');
assert.ok(!html.match(/id="current-server"[^>]*aria-live/));
assert.ok(html.match(/id="canvas-container"[^>]*role="region"/));
assert.ok(html.includes('id="btn-test-speech"'));
assert.ok(!html.includes('role="application"'));
console.log('Passed action labels, focus preservation and accessible markup.');
// Bind and activate the real test-button listener. Its only effect is one call.
const source = fs.readFileSync('docs/js/game-engine.js', 'utf8');
let click;
elements.set('btn-test-speech', { addEventListener(type, listener) {
  assert.equal(type, 'click'); click = listener;
} });
const start = source.indexOf("    const speechTestButton =");
const end = source.indexOf('    if (actionButton)', start);
vm.runInContext(source.slice(start, end), context);
calls.length = 0; click();
assert.equal(calls.length, 1);
assert.equal(calls[0][0], '音声案内のテストです。');
console.log('Passed speech test button without gameplay or settings side effects.');
