const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/js/game-engine.js', 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export class GameEngine', 'class GameEngine');
const constants = fs.readFileSync(__dirname + '/js/constants.js', 'utf8').replace(/export /g, '');
const GameEngine = vm.runInNewContext(constants + '\n' + source + '\nGameEngine');
for (const role of [1, 2]) {
  for (const server of [1, 2]) {
    const game = Object.create(GameEngine.prototype);
    Object.assign(game, { mode: 'cpu', difficulty: 'easy', role,
      ball: { easyReturnCount: 0, easyCpuAttempted: false } });
    let player = server === 1 ? 2 : 1;
    // Even if every random return succeeds, the CPU ends the rally before five returns.
    for (let i = 0; i < 10; i++) {
      if (player !== role && !game.canCpuReturn()) break;
      game.recordRallyReturn(player);
      player = player === 1 ? 2 : 1;
    }
    assert.ok(game.ball.easyReturnCount <= 4);
    assert.ok(game.ball.easyReturnCount >= 3);
    assert.equal(game.canCpuReturn(), false);
  }
}
const game = Object.create(GameEngine.prototype);
Object.assign(game, { difficulty: 'easy', ball: { easyReturnCount: 0, easyCpuAttempted: false } });
assert.equal(game.canCpuReturn(), true);
assert.equal(game.canCpuReturn(), false, 'A missed shot must not be retried next frame');
for (const difficulty of ['normal', 'hard']) {
  game.difficulty = difficulty;
  game.ball.easyReturnCount = 100;
  assert.equal(game.canCpuReturn(), true);
}
console.log('Easy rally limits and single-attempt checks passed.');
