const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const constants = fs.readFileSync(__dirname + '/js/constants.js', 'utf8').replace(/export /g, '');
const source = fs.readFileSync(__dirname + '/js/game-engine.js', 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export class GameEngine', 'class GameEngine');
const math = Object.create(Math);
const { GameEngine, calculateRallyReturnVelocity: velocity } = vm.runInNewContext(
  constants + '\n' + source + '\n({GameEngine, calculateRallyReturnVelocity})', { Math: math });
for (const direction of [-1, 1]) {
  for (const incomingSpeed of [4, 8, 15]) {
    for (const random of [0, 0.49, 0.5, 0.999]) {
      math.random = () => random;
      const cpu = velocity(0, incomingSpeed, 0.8, 'hard', direction, true);
      const speed = Math.hypot(cpu.vx, cpu.vy);
      assert.ok(random < 0.5 ? speed >= 5 && speed <= 6.5 : speed >= 10 && speed <= 11.5);
      assert.equal(Math.sign(cpu.vy), direction);
      assert.ok(Math.abs(cpu.vy) < 11.7);
      const player = velocity(0, incomingSpeed, 0.8, 'hard', direction);
      assert.ok(Math.abs(Math.hypot(player.vx, player.vy) - Math.min(incomingSpeed * 1.04, 15)) < 1e-9);
    }
  }
}
math.random = () => { throw new Error('Only Hard CPU returns may choose a pace'); };
velocity(0, 8, 0, 'hard', 1);
for (const difficulty of ['easy', 'normal']) velocity(0, 8, 0, difficulty, 1, true);
const game = Object.create(GameEngine.prototype);
game.difficulty = 'hard';
for (const pressed of [false, true]) {
  game.keys = { ArrowLeft: pressed, ArrowRight: false };
  const keys = game.getBallAssistKeys();
  assert.equal(keys.ArrowLeft, pressed);
  assert.equal(keys.ArrowRight, false);
}
console.log('Hard CPU pace, player returns, and manual movement checks passed.');
