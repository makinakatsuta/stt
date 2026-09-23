const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const constants = fs.readFileSync(__dirname + '/js/constants.js', 'utf8').replace(/export /g, '');
const source = fs.readFileSync(__dirname + '/js/game-engine.js', 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export class GameEngine', 'class GameEngine');
const math = Object.create(Math);
let feedbackEnabled = true;
const context = { Math: math, window: {}, console: { debug() {}, error(error) { throw error; } },
  setTimeout() {}, Date: { now: () => 0 },
  document: { getElementById: id => id === 'normal-feedback' ? { checked: feedbackEnabled } : null },
  narrator: { speak() {} },
  sounds: new Proxy({}, { get: () => () => {} }) };
const { GameEngine, normalCpuVelocity, predictedBallX } = vm.runInNewContext(
  constants + '\n' + source + '\n({GameEngine, normalCpuVelocity, predictedBallX})', context);
function game(role = 1) {
  const g = Object.create(GameEngine.prototype);
  Object.assign(g, { mode: 'cpu', difficulty: 'normal', state: 'RALLY', role,
    keys: { ArrowLeft: false, ArrowRight: false }, p1: { x: 350 }, p2: { x: 350 },
    ball: { x: 400, y: role === 1 ? 101 : 399, vx: 0, vy: role === 1 ? -7 : 7, active: true },
    normalPlayerReturns: 1, normalReturnCount: 1, lastMyPaddleX: 350, lastOppPaddleX: 350,
    processBufferedSwing() {}, checkTimeouts() {}, addRipple() {}, syncPaddlePosition() {},
    awardPointTo(winner, reason) { this.point = { winner, reason }; this.state = 'POINT_WON'; this.ball.active = false; } });
  return g;
}
math.random = () => 0.1;
const centered = game(); centered.prepareNormalCpuShot();
const wide = game(); wide.p2.x = 50; wide.prepareNormalCpuShot();
assert.ok(wide.ball.normalReturnChance < centered.ball.normalReturnChance);
assert.equal(wide.normalLastShotWide, true);
const savedPlan = JSON.stringify(wide.ball);
math.random = () => { throw new Error('A shot must not be rerolled each frame'); };
wide.prepareNormalCpuShot();
assert.equal(JSON.stringify(wide.ball), savedPlan);
for (const random of [0.1, 0.7, 0.9]) {
  math.random = () => random;
  const g = game(); g.prepareNormalCpuShot();
  const speed = g.ball.normalSpeed;
  assert.ok(random < 0.2 ? speed >= 5.5 && speed <= 6 : speed >= 6.5 && speed <= 7.5);
  const v = normalCpuVelocity(g.ball, 1);
  assert.ok(Math.abs(g.ball.x + v.vx * 300 / v.vy - g.ball.normalTargetX) < 1e-8);
}
math.random = () => 0.1;
const open = game(); open.normalReturnCount = 6; open.p1.x = 100; open.prepareNormalCpuShot();
assert.ok(open.ball.normalTargetX > 600);
open.normalReturnCount = 30; open.ball.normalPlanReady = false; open.prepareNormalCpuShot();
assert.ok(open.ball.normalReturnChance >= 0.68, 'No forced rally cutoff');
assert.ok(wide.normalFeedback(1, 'safe').includes('横'));
feedbackEnabled = false; assert.equal(wide.normalFeedback(1, 'safe'), ''); feedbackEnabled = true;
wide.normalPlayerReturns = 4; assert.ok(wide.normalFeedback(2, 'safe').includes('4回'));
assert.ok(predictedBallX(780, 400, 3, -6, 100) < 790);

async function integration() {
  require('./wasm_exec.js');
  const go = new Go();
  const wasm = await WebAssembly.instantiate(fs.readFileSync(__dirname + '/main.wasm'), go.importObject);
  go.run(wasm.instance);
  for (const useWasm of [false, true]) {
    context.window.updatePhysicsWasm = useWasm ? global.updatePhysicsWasm : undefined;
    for (const role of [1, 2]) {
      math.random = () => 0.1;
      const g = game(role); g.prepareNormalCpuShot(); g.ball.normalReturnChance = 1;
      const expected = normalCpuVelocity(g.ball, role === 1 ? 1 : -1);
      g.updatePhysics();
      assert.ok(Math.abs(g.ball.vx - expected.vx) < 1e-8);
      assert.ok(Math.abs(g.ball.vy - expected.vy) < 1e-8);
      assert.equal(g.normalReturnCount, 2);
      assert.equal((role === 1 ? g.p1 : g.p2).x, 350, 'No automatic player movement');
      const miss = game(role); miss.prepareNormalCpuShot(); miss.ball.normalReturnChance = 0;
      miss.updatePhysics(); miss.ball.normalReturnChance = 1;
      for (let frame = 0; frame < 30 && miss.ball.active; frame++) miss.updatePhysics();
      assert.equal(miss.normalReturnCount, 1, 'A missed CPU shot cannot retry');
      assert.equal(miss.point.winner, role);
      assert.equal(miss.point.reason, 'safe');
      const reset = game(role); reset.ball.normalCpuAttempted = true;
      reset.recordRallyReturn(role);
      assert.equal(reset.ball.normalCpuAttempted, false);
      assert.equal(reset.ball.normalPlanReady, true);
    }
    for (const difficulty of ['easy', 'normal', 'hard']) {
      for (const role of [1, 2]) {
        for (const tilt of [1, 0.3, 0]) {
          const g = game(role); g.difficulty = difficulty;
          g.useTilt = true; g.tiltSpeed = tilt; g.keys.ArrowRight = true;
          g.ball.y = 250; g.ball.vx = 2; g.ball.easyReturnCount = 0;
          g.updatePhysics();
          const speed = difficulty === 'easy' ? 8.5 : difficulty === 'normal' ? 8 : 7.2;
          assert.ok(Math.abs((role === 1 ? g.p1 : g.p2).x - (350 + speed * tilt)) < 1e-8);
          assert.equal((role === 1 ? g.p2 : g.p1).x > 350, true, 'CPU predicts the landing position');
        }
        const missed = game(role); missed.difficulty = difficulty;
        Object.assign(missed.ball, { easyReturnCount: 4, easyCpuAttempted: true,
          normalCpuAttempted: true, hardCpuAttempted: true });
        for (let n = 0; n < 30 && missed.ball.active; n++) missed.updatePhysics();
        assert.equal(missed.point.winner, role);
        assert.equal(missed.point.reason, 'safe');
        for (const serverRole of [1, 2]) {
          missed.serverRole = serverRole; missed.prepareServeSequence();
          assert.equal(missed.ball.easyReturnCount, 0);
          assert.equal(missed.ball.easyCpuAttempted, false);
          assert.equal(missed.ball.normalCpuAttempted, false);
          assert.equal(missed.ball.hardCpuAttempted, false);
          assert.equal(missed.ball.normalPlanReady, false);
          assert.equal(missed.normalReturnCount, 0);
        }
        if (difficulty !== 'normal') {
          let successes = 0, slow = 0, fast = 0;
          for (let shot = 0; shot < 160; shot++) {
            math.random = () => shot % 2 ? 0.7 : 0.1;
            const hit = game(role); hit.difficulty = difficulty; hit.ball.easyReturnCount = 0;
            hit.updatePhysics();
            const returned = role === 1 ? hit.ball.vy > 0 : hit.ball.vy < 0;
            if (!returned) continue;
            successes++;
            const speed = Math.hypot(hit.ball.vx, hit.ball.vy);
            if (difficulty === 'easy') assert.ok(Math.abs(speed - 7.07) < 1e-8);
            else if (speed >= 5 && speed <= 6.5) slow++;
            else if (speed >= 10 && speed <= 11.5) fast++;
            else assert.fail('Invalid Hard CPU speed');
          }
          assert.ok(successes > 0);
          if (difficulty === 'hard') assert.ok(slow > 0 && fast > 0);
        }
      }
    }
  }
  if (process.env.STT_BENCHMARK === '1') {
    for (const useWasm of [false, true]) {
      context.window.updatePhysicsWasm = useWasm ? global.updatePhysicsWasm : undefined;
      let seed = 12345;
      math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
      const counts = [];
      for (let rally = 0; rally < 200; rally++) {
        const g = game(); g.ball.y = 390;
        for (let frame = 0; frame < 10000 && g.ball.active; frame++) {
          if (g.ball.vy > 0 && g.ball.y >= 390) {
            // Synthetic player: perfect positioning with varying contact points.
            // This is a physics benchmark, not a beginner/user study.
            g.p1.x = Math.max(10, Math.min(690, g.ball.x - 50 + (rally % 3 - 1) * 35));
            g.tryPlayerReturn();
          }
          g.updatePhysics();
        }
        assert.ok(g.point, 'Synthetic rally must end');
        counts.push(g.normalReturnCount);
      }
      counts.sort((a, b) => a - b);
      console.log(JSON.stringify({ benchmark: useWasm ? 'WASM' : 'JS', syntheticRallies: counts.length,
        meanReturns: Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)),
        medianReturns: counts[100], maxReturns: counts.at(-1) }));
    }
  }
  console.log('All difficulties: JS/WASM movement, CPU returns, rally resets, pace and end-line checks passed.');
}
integration().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
