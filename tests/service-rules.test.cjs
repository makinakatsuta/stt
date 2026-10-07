const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let now = 1000;
const calls = [];
const context = vm.createContext({ Date: { now: () => now }, Math, window: {},
  document: { getElementById: () => null }, console: { error: e => { throw e; } },
  narrator: { speak: (...args) => calls.push({ args, at: now }) },
  sounds: new Proxy({}, { get: () => () => {} }) });
vm.runInContext(fs.readFileSync('docs/js/constants.js', 'utf8').replace(/export \{[^}]+\};/, '') + '\n' +
  fs.readFileSync('docs/js/game-engine.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') +
  '\nglobalThis.Engine = GameEngine;', context);
function game(serverRole = 1, mode = 'cpu') {
  const g = Object.create(context.Engine.prototype);
  Object.assign(g, { mode, role: 1, serverRole, difficulty: 'normal', ball: {}, p1: {}, p2: {}, keys: {},
    scores: { p1: 0, p2: 0 }, gameScores: { p1: 0, p2: 0 }, maxScore: 11, matchGames: 3,
    tasks: [], clearGameplayTasks() { this.tasks.length = 0; },
    scheduleGameplayTask(fn, delay) { this.tasks.push({ fn, at: now + delay }); },
    isServerAndDecider: () => true, updateScoreboard() {}, addRipple() {}, net: { send() {}, paddleLastSent: now } });
  g.prepareServeSequence();
  if (g.state === 'SERVE_SELECT') {
    calls.length = 0;
    if (g.isMyTurnToServe()) g.selectServeType(1);
    else g.handleOpponentAction({ actionType: 'serve_selected', serveType: 1 });
  }
  return g;
}
function runTask(g) {
  const task = g.tasks.shift(); now = task.at; task.fn();
}
for (const server of [1, 2]) {
  calls.length = 0;
  const g = game(server);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], `${server === 1 ? 'サーブ1。' : ''}プレー。${server === 1 ? 'あなた' : 'CPU'}のサーブです。`);
  assert.equal(calls[0].args[1], true);
  assert.equal(g.stateStartTime, calls[0].at);
}
// Inclusive deadlines, plus input arriving after the deadline but before a frame.
for (const server of [1, 2]) for (const [state, limit, winner] of [
  ['PRE_SERVE_READY', 10000, 3 - server], ['PRE_SERVE_HEARD', 5000, server],
  ['SERVE_WAITING', 5000, 3 - server]
]) for (const offset of [-1, 0, 1]) {
  const g = game(server, 'online');
  g.state = state; g.role = state === 'PRE_SERVE_HEARD' ? 3 - server : server;
  const start = g.stateStartTime;
  calls.length = 0;
  now = start + limit + offset;
  g.handleActionInput();
  if (offset > 0) {
    assert.equal(g.state, 'POINT_WON');
    assert.equal(g.scores[`p${winner}`], 1);
    assert.equal(g.scores[`p${3 - winner}`], 0);
    assert.ok(calls[0].args[0].includes('オーバータイム'));
    g.checkTimeouts(); assert.equal(g.scores[`p${winner}`], 1);
  } else {
    assert.equal(g.state, state === 'PRE_SERVE_READY' ? 'PRE_SERVE_HEARD' : state === 'PRE_SERVE_HEARD' ? 'SERVE_WAITING' : 'RALLY');
    assert.equal(g.scores.p1 + g.scores.p2, 0);
    if (state === 'SERVE_WAITING') assert.equal(g.ball.active, true);
    else assert.equal(g.stateStartTime, now);
  }
}
// Real CPU callbacks, including throttled callbacks that run too late.
for (const server of [1, 2]) for (const [state, limit, winner] of [
  ['PRE_SERVE_READY', 10000, 3 - server], ['PRE_SERVE_HEARD', 5000, server],
  ['SERVE_WAITING', 5000, 3 - server]
]) {
  const g = game(server);
  g.state = state;
  now = g.stateStartTime + limit;
  g.checkTimeouts(); assert.equal(g.state, state);
  now++;
  g.checkTimeouts(); assert.equal(g.scores[`p${winner}`], 1);
  assert.equal(g.state, 'POINT_WON');
}
// Online calls and serves must also respect the current deadline.
for (const [state, payload, winner] of [
  ['PRE_SERVE_READY', { actionType: 'voice_call', call: 'ikimasu' }, 2],
  ['PRE_SERVE_HEARD', { actionType: 'voice_call', call: 'hai' }, 1],
  ['SERVE_WAITING', { actionType: 'serve', x: 400, y: 390, vx: 1, vy: -5 }, 2]
]) {
  const g = game(1, 'online'); g.state = state;
  now = g.stateStartTime + (state === 'PRE_SERVE_READY' ? 10001 : 5001);
  g.handleOpponentAction(payload);
  assert.equal(g.state, 'POINT_WON'); assert.equal(g.scores[`p${winner}`], 1);
}
for (const server of [1, 2]) {
  const g = game(server);
  if (server === 1) {
    g.handleActionInput(); const start = now; runTask(g);
    assert.ok(now - start < 5000); assert.equal(g.state, 'SERVE_WAITING');
    g.handleActionInput();
  } else {
    const start = now; runTask(g); assert.ok(now - start < 10000);
    assert.equal(g.state, 'PRE_SERVE_HEARD');
    g.handleActionInput(); const reply = now; runTask(g); assert.ok(now - reply < 5000);
  }
  assert.equal(g.state, 'RALLY'); assert.equal(g.ball.active, true);
  assert.equal(g.scores.p1 + g.scores.p2, 0);
}
for (const stage of ['call', 'reply', 'serve']) {
  const g = game(stage === 'reply' ? 1 : 2);
  if (stage === 'reply') g.handleActionInput();
  if (stage === 'serve') { runTask(g); g.handleActionInput(); }
  now = g.stateStartTime + (stage === 'call' ? 10001 : 5001);
  g.tasks.shift().fn();
  assert.equal(g.state, 'POINT_WON');
  assert.equal(g.scores.p1, 1);
}
// Ball stays fixed while the server moves the paddle, in both physics paths.
for (const wasm of [false, true]) for (const server of [1, 2]) {
  context.window.updatePhysicsWasm = wasm ? (ball, p1, p2) => { assert.equal(ball.vx, 0); assert.equal(ball.vy, 0); return { ball, p1, p2, events: [] }; } : undefined;
  const g = game(server);
  const { x, y } = g.ball;
  for (const state of ['SERVE_SELECT', 'PRE_SERVE_READY', 'PRE_SERVE_HEARD', 'SERVE_WAITING']) {
    g.state = state; g.stateStartTime = now;
    g.p1.x += 20; g.p2.x += 20;
    g.updatePhysics();
    assert.deepEqual([g.ball.x, g.ball.y, g.ball.vx, g.ball.vy, g.ball.active], [x, y, 0, 0, false]);
  }
}
console.log('Passed service announcements, 10/5/5 boundaries, scoring, CPU callbacks and stationary balls.');
