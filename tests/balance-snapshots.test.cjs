const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let seed;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const quiet = new Proxy({}, { get: () => () => {} });
const context = vm.createContext({ Math: Object.assign(Object.create(Math), { random }),
  window: {}, sounds: quiet, narrator: quiet, Date: { now: () => 1000 },
  console, document: { getElementById: () => null } });
vm.runInContext(fs.readFileSync('docs/js/constants.js', 'utf8').replace(/export \{[^}]+\};/, '') + '\n' +
  fs.readFileSync('docs/js/game-engine.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') +
  '\nglobalThis.Engine = GameEngine; globalThis.velocity = calculateRallyReturnVelocity;', context);
function game(difficulty, role, count, x) {
  const g = Object.create(context.Engine.prototype);
  Object.assign(g, { difficulty, role, mode: 'cpu', state: 'RALLY', keys: {},
    p1: { x: 350 }, p2: { x: 350 }, normalReturnCount: count, pendingSwingUntil: 0,
    ball: { x, y: 250, vx: 3, vy: role === 1 ? -6 : 6, active: true, easyReturnCount: count } });
  for (const method of ['processBufferedSwing', 'checkTimeouts', 'syncPaddlePosition', 'addRipple']) g[method] = () => {};
  g.getBallAssistKeys = () => g.keys;
  g.awardPointTo = winner => { g.winner = winner; g.ball.active = false; };
  return g;
}
function capture(difficulty) {
  const constants = {};
  const names = difficulty === 'easy'
    ? ['EASY_RALLY_ACCELERATION', 'EASY_RALLY_MAX_SPEED', 'EASY_CPU_DIFFICULTY_FACTOR', 'EASY_CPU_RETURN_CHANCE',
      'EASY_RALLY_RETURN_LIMIT', 'EASY_SERVE_VY_MIN', 'EASY_SERVE_VY_MAX', 'EASY_SERVE_VX_MIN',
      'EASY_SERVE_VX_MAX', 'EASY_SERVE_SPEED_FACTOR', 'EASY_SIDE_OUT_CHANCE']
    : ['HARD_RALLY_ACCELERATION', 'HARD_RALLY_MAX_SPEED', 'HARD_DIFFICULTY_FACTOR', 'HARD_HIT_ZONE',
      'HARD_PADDLE_MARGIN', 'HARD_FAST_SERVE_CHANCE', 'HARD_SIDE_OUT_CHANCE'];
  for (const name of names) constants[name] = vm.runInContext(name, context);
  const plans = [], contacts = [], velocities = [];
  for (const role of [1, 2]) for (const count of [0, 2, 4, 6, 7, 12]) for (const x of [30, 400, 770]) {
    seed = 100 + role + count + x;
    const g = game(difficulty, role, count, x);
    g.prepareNormalCpuShot();
    g.updatePhysics();
    plans.push({ role, count, x, ball: { ...g.ball }, p1: g.p1.x, p2: g.p2.x });
    // Sample real CPU contact, grace, single-attempt and fatigue behavior.
    for (let sample = 0; sample < 16; sample++) {
      seed = 100 + sample + role + count + x;
      const contact = game(difficulty, role, count, x);
      contact.ball.y = role === 1 ? 106 : 394;
      contact.updatePhysics();
      contacts.push({ role, count, x, sample, ball: { ...contact.ball },
        p1: contact.p1.x, p2: contact.p2.x, winner: contact.winner || null });
    }
  }
  for (const direction of [-1, 1]) for (const speed of [4, 8, 14]) for (const hit of [-1, 0, 1]) {
    velocities.push({ direction, speed, hit, ...context.velocity(3, speed, hit, difficulty, direction) });
  }
  return JSON.parse(JSON.stringify({ constants, plans, contacts, velocities }));
}
for (const difficulty of ['easy', 'hard']) {
  const path = `tests/fixtures/${difficulty}-balance.json`;
  const actual = capture(difficulty);
  if (process.argv.includes('--capture-baseline')) {
    // Initial baseline only: never overwrite an existing expectation.
    fs.writeFileSync(path, JSON.stringify(actual, null, 2) + '\n', { flag: 'wx' });
  } else assert.deepEqual(actual, JSON.parse(fs.readFileSync(path, 'utf8')), `${difficulty} balance changed`);
}
console.log('Easy/Hard fixed balance snapshots passed.');
