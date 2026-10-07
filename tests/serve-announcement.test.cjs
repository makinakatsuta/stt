const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const calls = [];
const elements = new Map();
const document = { getElementById(id) {
  if (!elements.has(id)) elements.set(id, { textContent: '', classList: { add() {}, toggle() {} }, setAttribute() {}, removeAttribute() {} });
  return elements.get(id);
} };
const context = vm.createContext({ document, window: {}, Date, Math,
  sounds: new Proxy({}, { get: () => () => {} }),
  narrator: { speak: (...args) => calls.push(args), stop() {} }, console });
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
  const g = game(mode, role, serverRole);
  g.net = { send() {} };
  g.prepareServeSequence();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], name === 'CPU' ? 'プレー。CPUのサーブです。' :
    name === 'あなた' ? 'サーブを選択してください。' : '対戦相手がサーブを選択しています。');
  if (name !== 'CPU') {
    calls.length = 0;
    if (g.isMyTurnToServe()) g.selectServeType(2);
    else g.handleOpponentAction({ actionType: 'serve_selected', serveType: 2 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `${name === 'あなた' ? 'サーブ2。' : ''}プレー。${name}のサーブです。`);
  }
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
// The name and node stay fixed across every state and perspective.
for (const mode of ['cpu', 'online']) {
  for (const role of [1, 2]) {
    for (const server of [1, 2]) {
      const g = game(mode, role, server);
      for (const state of vm.runInContext('[STATE_PRE_SERVE_READY, STATE_PRE_SERVE_HEARD, STATE_SERVE_WAITING, STATE_RALLY, STATE_POINT_WON, STATE_MENU]', context)) {
        g.state = state;
        calls.length = 0;
        g.updateActionButton();
        assert.equal(calls.length, 0);
      }
    }
  }
}
const html = fs.readFileSync('docs/index.html', 'utf8');
assert.ok(!html.match(/id="current-server"[^>]*aria-live/));
const areaTag = html.match(/<div[^>]*id="canvas-container"[^>]*>/)[0];
assert.doesNotMatch(areaTag, /role="button"|aria-label=|tabindex="0"/);
assert.ok(!html.includes('>サーブ・返球</button>'));
assert.ok(html.includes('id="btn-test-speech"'));
assert.equal((html.match(/role="application"/g) || []).length, 1);
assert.ok(html.match(/id="game-input-area"[^>]*role="application"/));
console.log('Passed action labels, focus preservation and accessible markup.');
// Bind and activate the real test-button listener. Its only effect is one call.
const source = fs.readFileSync('docs/js/game-engine.js', 'utf8');
let click;
elements.set('btn-test-speech', { addEventListener(type, listener) {
  assert.equal(type, 'click'); click = listener;
} });
const start = source.indexOf("    const speechTestButton =");
const end = source.indexOf('    const rangeSpeechRate', start);
vm.runInContext(source.slice(start, end), context);
calls.length = 0; click();
assert.equal(calls.length, 1);
assert.equal(calls[0][0], '音声案内のテストです。');
console.log('Passed speech test button without gameplay or settings side effects.');

assert.ok(!html.includes("btn-game-action"));
assert.ok(html.match(/class="scoreboard"[^>]*aria-hidden="true"/));
for (const id of ['current-server', 'referee-message', 'play-instructions', 'game-action-hint']) {
  const tag = html.match(new RegExp('<[^>]*id="' + id + '"[^>]*>'))[0];
  assert.ok(tag.includes('aria-hidden="true"'), id);
}
const announcerTag = html.match(/<div\b[^>]*id="sr-announcer"[^>]*>/)[0];
assert.ok(!announcerTag.includes('aria-hidden'));
assert.ok(announcerTag.includes('aria-live="polite"'));
for (const [reason, label] of [['out', 'アウト'], ['safe', 'セーフ'], ['miss', 'リターンミス']]) {
  for (const winner of [1, 2]) {
    calls.length = 0;
    game('cpu', 1, 1).awardPointTo(winner, reason);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `${label}、ポイント ${winner === 1 ? 'プレイヤー' : 'CPU'}。 ${winner === 1 ? 1 : 0} 対 ${winner === 2 ? 1 : 0}。`);
  }
}
const handshake = game('cpu', 1, 1);
let reply;
handshake.scheduleGameplayTask = fn => { reply = fn; };
handshake.prepareServeSequence();
handshake.selectServeType(1);
calls.length = 0;
handshake.handleActionInput();
reply();
assert.deepEqual(calls.map(call => call[0]), ['いきます', 'はい']);
console.log('Passed visual status isolation and existing point, score and handshake announcements.');

// Result actions must become accessible again, including after a rematch.
const instructionAttributes = new Map();
elements.set('play-instructions', {
  classList: { add() {}, remove() {} },
  setAttribute: (name, value) => instructionAttributes.set(name, value),
  removeAttribute: name => instructionAttributes.delete(name),
  querySelectorAll: () => []
});
for (const id of ['btn-play-again', 'btn-quit-to-menu']) {
  elements.set(id, { addEventListener() {}, focus() {} });
}
const finished = game('cpu', 1, 1);
finished.stopLoop = () => {};
const chromeAttributes = new Map();
elements.set('game-footer', {
  setAttribute: (name, value) => chromeAttributes.set(name, value),
  removeAttribute: name => chromeAttributes.delete(name)
});
finished.prepareServeSequence();
assert.equal(chromeAttributes.has('inert'), true);
assert.equal(instructionAttributes.get('aria-hidden'), 'true');
calls.length = 0;
finished.finishMatch(1);
assert.equal(chromeAttributes.has('inert'), false);
assert.equal(calls.length, 1);
assert.equal(calls[0][0], 'マッチ終了！ 勝者は、プレイヤー です！おめでとうございます！');
assert.equal(instructionAttributes.has('aria-hidden'), false);
finished.prepareServeSequence();
assert.equal(chromeAttributes.has('inert'), true);
assert.equal(instructionAttributes.get('aria-hidden'), 'true');
console.log('Passed match-end announcement and result/rematch accessibility.');
