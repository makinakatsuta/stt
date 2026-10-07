const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
globalThis.crypto = require('node:crypto').webcrypto;
require('../docs/wasm_exec.js');
let now = 1000, seed = 20261007;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const calls = [], serves = [], elements = new Map();
const html = fs.readFileSync('docs/index.html', 'utf8');
const documentListeners = new Map();
const document = { activeElement: null, getElementById: id => elements.get(id) || null,
  addEventListener: (type, callback) => documentListeners.set(type, callback) };
for (const id of ['serve-selection', 'canvas-container', 'btn-serve-1', 'btn-serve-2', 'btn-serve-3']) {
  const tag = html.match(new RegExp('<(?:button|div)\\b[^>]*id="' + id + '"[^>]*>'))[0];
  elements.set(id, { id, hidden: tag.includes(' hidden'), disabled: tag.includes(' disabled'), listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, focus() { document.activeElement = this; }, blur() { document.activeElement = document.body; } });
}
const quiet = new Proxy({ playServeSound: (...args) => serves.push(args) }, { get: (obj, key) => obj[key] || (() => {}) });
const context = vm.createContext({ document, window: {}, Date: { now: () => now },
  Math: Object.assign(Object.create(Math), { random }), sounds: quiet, narrator: { speak: text => calls.push(text) },
  console: { error(e) { throw e; } } });
const source = fs.readFileSync('docs/js/game-engine.js', 'utf8');
vm.runInContext(fs.readFileSync('docs/js/constants.js', 'utf8').replace(/export \{[^}]+\};/, '') + '\n' +
  source.replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') + '\nglobalThis.Engine = GameEngine;', context);
vm.runInContext(source.match(/    const isControl = .*;/)[0], context);
const keyStart = source.indexOf("    document.addEventListener('keydown'");
const bindKeyboard = vm.runInContext('(function(){' + source.slice(keyStart,
  source.indexOf('    // ウィンドウ切り替え', keyStart)) + '\n})', context);
function game(difficulty = 'normal', mode = 'cpu', serverRole = 1, role = 1) {
  const g = Object.create(context.Engine.prototype);
  Object.assign(g, { difficulty, mode, serverRole, role, ball: {}, p1: { x: 350 }, p2: { x: 350 }, keys: {},
    scores: { p1: 0, p2: 0 }, gameScores: { p1: 0, p2: 0 }, maxScore: 11, matchGames: 3,
    tasks: [], sent: [], clearGameplayTasks() { this.tasks = []; },
    scheduleGameplayTask(fn, delay) { this.tasks.push({ fn, at: now + delay }); },
    updateScoreboard() {}, addRipple() {}, isServerAndDecider: () => true });
  g.net = { send: (...args) => g.sent.push(args), paddleLastSent: now };
  g.prepareServeSequence();
  return g;
}
function reply(g) { const task = g.tasks.shift(); now = task.at; task.fn(); }
// The actual native button listeners and keyboard selector share selectServeType.
for (const input of ['Digit', 'Numpad', 'key', 'button']) for (const type of [1, 2, 3]) {
  calls.length = 0; serves.length = 0;
  const g = game(); g.setupServeSelection();
  g.screens = { play: { classList: { contains: () => false } }, help: { classList: { contains: () => true } } };
  bindKeyboard.call(g);
  assert.equal(g.state, 'SERVE_SELECT'); assert.equal(g.selectedServeType, null);
  assert.equal(g.stateStartTime, 0); assert.equal(g.tasks.length, 0);
  assert.ok(!calls.some(call => call.includes('プレー')));
  assert.equal(elements.get('serve-selection').hidden, false);
  for (const n of [1, 2, 3]) {
    assert.match(html, new RegExp('<button[^>]*id="btn-serve-' + n + '"[^>]*type="button"[^>]*>サーブ' + n + '</button>'));
    assert.equal(elements.get(`btn-serve-${n}`).disabled, false);
  }
  now += 60000; g.checkTimeouts(); g.handleActionInput();
  assert.equal(g.state, 'SERVE_SELECT'); assert.equal(g.scores.p1 + g.scores.p2, 0);
  assert.equal(g.ball.active, false); assert.equal(g.stateStartTime, 0);
  g.beginServicePlay(); assert.equal(g.state, 'SERVE_SELECT');
  let selected = 0; const select = g.selectServeType;
  g.selectServeType = function(n, fromButton) { selected++; return select.call(this, n, fromButton); };
  if (input === 'button') {
    const button = elements.get(`btn-serve-${type}`); button.focus();
    button.listeners.click({ stopPropagation() {} });
    assert.equal(document.activeElement, document.body);
    assert.ok(calls.at(-1).includes('プレー'));
    assert.equal(g.tasks.length, 0, 'no delayed focus transfer');
  } else {
    const priorFocus = document.activeElement;
    let prevented = false;
    documentListeners.get('keydown')({ code: input === 'key' ? '' : input + type,
      key: String(type), preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, priorFocus);
    assert.equal(g.tasks.length, 0);
  }
  assert.equal(selected, 1); assert.equal(g.selectedServeType, type);
  assert.equal(g.state, 'PRE_SERVE_READY'); assert.equal(g.stateStartTime, now);
  assert.equal(calls.at(-1), `サーブ${type}。プレー。あなたのサーブです。`);
  if (input === 'button') {
    let actions = 0;
    const action = g.handleActionInput;
    g.handleActionInput = () => actions++;
    documentListeners.get('keydown')({ code: 'Space', key: ' ', target: document.activeElement,
      preventDefault() {} });
    assert.equal(actions, 1, 'Space still works after the selected button disappears');
    g.handleActionInput = action;
  }
  assert.equal(g.ball.active, false); assert.equal(serves.length, 0);
  assert.equal(elements.get('serve-selection').hidden, true);
  for (const n of [1, 2, 3]) assert.equal(elements.get(`btn-serve-${n}`).disabled, true);
  for (const stage of ['PRE_SERVE_READY', 'PRE_SERVE_HEARD', 'SERVE_WAITING', 'RALLY']) {
    assert.equal(g.state, stage);
    assert.equal(select.call(g, 4 - type), false); assert.equal(g.selectedServeType, type);
    assert.equal(g.handleServeSelectionKey({ code: 'Digit2', preventDefault() { throw Error('locked'); } }), false);
    if (stage === 'PRE_SERVE_READY') { now += 9999; g.checkTimeouts(); g.handleActionInput(); }
    if (stage === 'PRE_SERVE_HEARD') reply(g);
    if (stage === 'SERVE_WAITING') { now += 4999; g.handleActionInput(); }
  }
  assert.equal(g.ball.active, true); assert.equal(serves.at(-1)[4], type);
  g.prepareServeSequence(); assert.equal(g.state, 'SERVE_SELECT'); assert.equal(g.selectedServeType, null);
}
// AT click with body focus never schedules a focus transfer.
{
  document.body = {};
  const g = game(); g.setupServeSelection(); document.activeElement = document.body;
  elements.get('btn-serve-2').listeners.click({ stopPropagation() {} });
  assert.equal(document.activeElement, document.body);
  assert.equal(g.tasks.length, 0);
}
// Legacy charge fields cannot influence an actual service, even if injected.
for (const difficulty of ['easy', 'normal', 'hard']) {
  const outcomes = [];
  for (const hold of [0, 10, 1500, 60000]) {
    seed = 12345;
    const g = game(difficulty); g.selectServeType(2); g.handleActionInput(); reply(g);
    g.isCharging = true; g.chargeStartTime = now - hold;
    g.handleActionInput();
    outcomes.push(JSON.stringify([g.ball.vx, g.ball.vy, g.selectedServeType, g.ball.isPowerServe]));
  }
  assert.equal(new Set(outcomes).size, 1);
}
assert.ok(!/isCharging|chargeStartTime|chargeRatio|chargeTime/.test(source));
// CPU never shows selection; online receiver waits for the remote selection.
const cpu = game('normal', 'cpu', 2);
assert.equal(cpu.state, 'PRE_SERVE_READY'); assert.equal(elements.get('serve-selection').hidden, true);
assert.equal(cpu.selectServeType(3), false); assert.equal(cpu.tasks.length, 1);
for (const role of [1, 2]) {
  const sender = game('hard', 'online', role, role);
  const receiver = game('hard', 'online', role, 3 - role);
  assert.equal(receiver.state, 'SERVE_SELECT'); assert.equal(receiver.stateStartTime, 0);
  assert.equal(elements.get('serve-selection').hidden, true);
  receiver.handleOpponentAction({ actionType: 'voice_call', call: 'ikimasu' });
  assert.equal(receiver.state, 'SERVE_SELECT');
  sender.selectServeType(3); receiver.handleOpponentAction(sender.sent.at(-1)[1]);
  assert.equal(receiver.state, 'PRE_SERVE_READY'); assert.equal(receiver.selectedServeType, 3);
  sender.handleActionInput(); receiver.handleOpponentAction(sender.sent.at(-1)[1]);
  receiver.handleActionInput(); sender.handleOpponentAction(receiver.sent.at(-1)[1]);
  sender.handleActionInput(); receiver.handleOpponentAction(sender.sent.at(-1)[1]);
  assert.equal(sender.state, 'RALLY'); assert.equal(receiver.state, 'RALLY');
  assert.equal(sender.ball.playerServePending, false); assert.equal(sender.ball.isPowerServe, false);
  assert.equal(sender.ball.serveReturnChance, null);
  assert.equal(sender.ball.vy, receiver.ball.vy); assert.equal(serves.at(-1)[4], 3);
  const seeded = context.Math.random;
  context.Math.random = () => { throw Error('online CPU probability must not run'); };
  assert.equal(sender.preparePlayerServe(7), 7);
  context.Math.random = seeded;
}
// Exercise the real sound buffer selection without adding any recording.
const soundSource = fs.readFileSync('docs/js/sound-system.js', 'utf8');
vm.runInContext(soundSource.replace(/^import .*;\r?\n/gm, '').replace('export class', 'class')
  .replace(/export const sounds = new SoundSystem\(\);/, '') + '\nglobalThis.Sound = SoundSystem;', context);
for (const type of [1, 2, 3]) {
  let played;
  const s = Object.create(context.Sound.prototype);
  s.serveBuffers = { easy: 'serve1', normal: 'serve2', hard: 'serve3' };
  s.ctx = { currentTime: 0, destination: {}, createBufferSource: () => ({ connect() {}, start() { played = this.buffer; } }),
    createGain: () => ({ gain: { setValueAtTime() {} }, connect() {} }) };
  s.create3DPanner = () => ({ connect() {} });
  s.playServeSound(400, 'hard', 390, false, type); assert.equal(played, `serve${type}`);
  const seeded = context.Math.random;
  context.Math.random = () => [0.05, 0.8, 0.95][type - 1];
  s.playServeSound(400, 'easy', 100, true, 3); assert.equal(played, `serve${type}`);
  context.Math.random = seeded;
}
assert.ok(source.includes('this.state === STATE_SERVE_SELECT && this.handleServeSelectionKey(e)'));
console.log('Passed selection ordering, 60-second selection wait, native buttons/focus, keyboard/numpad, locks, sounds and online synchronization.');
if (process.argv.includes('--selection-only')) process.exit(0);

async function main() {
  const go = new Go();
  const { instance } = await WebAssembly.instantiate(fs.readFileSync('docs/main.wasm'), go.importObject);
  go.run(instance); await new Promise(resolve => setImmediate(resolve));
  const rows = [];
  for (const backend of ['js', 'wasm']) {
    context.window.updatePhysicsWasm = backend === 'wasm' ? globalThis.updatePhysicsWasm : undefined;
    // Force both return outcomes, verify one attempt and the existing score path.
    for (const difficulty of ['easy', 'normal', 'hard']) for (const success of [true, false]) {
      const g = game(difficulty); g.selectServeType(1); g.handleActionInput(); reply(g); g.handleActionInput();
      g.ball.x = 400; g.ball.y = 106; g.ball.vx = 0; g.ball.vy = -6;
      const seeded = context.Math.random; context.Math.random = () => success ? 0 : 0.999999;
      g.updatePhysics();
      if (success) {
        assert.ok(g.ball.vy > 0); assert.equal(g.state, 'RALLY'); assert.equal(g.ball.playerServePending, false);
        assert.equal(g.scores.p1 + g.scores.p2, 0);
      } else {
        assert.ok(g.ball.vy < 0); assert.equal(g.state, 'RALLY');
        for (let frame = 0; frame < 50 && g.state === 'RALLY'; frame++) g.updatePhysics();
        assert.equal(g.state, 'POINT_WON'); assert.equal(g.scores.p1, 1); assert.equal(g.scores.p2, 0);
      }
      context.Math.random = seeded;
    }
    for (const difficulty of ['easy', 'normal', 'hard']) for (const type of [1, 2, 3]) {
      seed = 20261007;
      let power = 0, returns = 0, aces = 0;
      const trials = 10000;
      for (let trial = 0; trial < trials; trial++) {
        const g = game(difficulty); g.selectServeType(type); g.handleActionInput(); reply(g); g.handleActionInput();
        if (g.ball.isPowerServe) power++;
        assert.equal(g.scores.p1 + g.scores.p2, 0);
        for (let frame = 0; frame < 250 && g.state === 'RALLY' && g.ball.playerServePending; frame++) g.updatePhysics();
        if (!g.ball.playerServePending) { returns++; assert.equal(g.state, 'RALLY'); }
        else { assert.equal(g.state, 'POINT_WON'); assert.equal(g.scores.p1, 1); aces++; }
      }
      const row = { backend, difficulty, type, trials, power: power / trials, returns: returns / trials, aces: aces / trials };
      rows.push(row); assert.ok(row.aces > 0 && row.aces < 0.30);
      assert.ok(Math.abs(row.power - [0.1, 0.2, 0.3][type - 1]) < 0.02);
      console.log(JSON.stringify(row));
    }
    const subset = rows.filter(row => row.backend === backend);
    for (const difficulty of ['easy', 'normal', 'hard']) {
      const rates = subset.filter(row => row.difficulty === difficulty).map(row => row.aces);
      assert.ok(rates[0] < rates[1] && rates[1] < rates[2]);
    }
    for (const type of [1, 2, 3]) {
      const rates = subset.filter(row => row.type === type).map(row => row.aces);
      assert.ok(rates[0] < rates[1] && rates[1] < rates[2]);
    }
  }
  console.log('Passed 180,000 actual JS/WASM services, nine probability combinations, return/score paths and monotonic ace rates.');
  process.exit(0);
}
main().catch(error => { console.error(error); process.exit(1); });
