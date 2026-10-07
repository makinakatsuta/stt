const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const document = { documentElement: { dataset: {} } };
const context = vm.createContext({ document });
vm.runInContext(fs.readFileSync('docs/js/constants.js', 'utf8').replace(/export \{[^}]+\};/, '') + '\n' +
  fs.readFileSync('docs/js/game-engine.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class', 'class') +
  '\nglobalThis.Engine = GameEngine;', context);
const palettes = { default: ['#164854', '#ffffff'], 'white-on-black': ['#000000', '#ffffff'],
  'black-on-white': ['#ffffff', '#000000'], 'yellow-on-black': ['#000000', '#ffff00'] };
for (const difficulty of ['easy', 'normal', 'hard']) for (const [contrast, [table, ball]] of Object.entries(palettes)) {
  document.documentElement.dataset.contrast = contrast;
  const calls = [], stack = [];
  const ctx = { globalAlpha: 1 };
  for (const method of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'fillText']) {
    ctx[method] = (...args) => calls.push({ method, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle, alpha: ctx.globalAlpha });
  }
  ctx.save = () => stack.push({ fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, globalAlpha: ctx.globalAlpha });
  ctx.restore = () => Object.assign(ctx, stack.pop());
  const g = Object.create(context.Engine.prototype);
  Object.assign(g, { ctx, difficulty, ripples: [], p1: { x: 250 }, p2: { x: 450 },
    ball: { active: true, x: 400, y: 250, vx: 99, vy: 99, normalTargetX: 770 } });
  const physics = JSON.stringify([g.ball, g.p1, g.p2]);
  g.draw();
  assert.equal(JSON.stringify([g.ball, g.p1, g.p2]), physics, 'drawing preserves physics');
  assert.ok(calls.some(c => c.method === 'fillRect' && c.fill === table && c.args.join() === '10,10,780,480'));
  assert.ok(calls.some(c => c.method === 'strokeRect' && c.args.join() === '10,240,780,20'), 'net boundary');
  for (const x of [7, 787]) assert.ok(calls.some(c => c.method === 'fillRect' && c.args.join() === `${x},235,6,30`), 'post');
  assert.deepEqual(calls.filter(c => c.method === 'fillText').map(c => c.args[0]), ['1', '2'], 'only paddle identifiers, no technical diagrams');
  const arcs = calls.filter(c => c.method === 'arc');
  assert.equal(arcs.length, 1, 'no extra predicted balls');
  assert.equal(arcs[0].fill, ball);
  assert.deepEqual(arcs[0].args.slice(0, 3), [400, 250, 10]);
  // Future velocity and CPU target cannot change the displayed frame.
  const first = JSON.stringify(calls);
  calls.length = 0; g.ball.vx = -99; g.ball.vy = -99; g.ball.normalTargetX = 30; g.draw();
  assert.equal(JSON.stringify(calls), first);
  for (let i = 1; i <= 10; i++) {
    calls.length = 0; g.ball.x = 400 + i; g.draw();
    const history = calls.filter(c => c.method === 'arc');
    assert.ok(history.length <= 5, 'at most four past ghosts');
    assert.ok(history.every(c => c.args[0] <= g.ball.x && c.args[0] >= g.ball.x - 4), 'actual recent positions only');
    assert.equal(history.at(-1).alpha, 1, 'current ball is opaque');
  }
  g.ball.active = false; calls.length = 0; g.draw();
  assert.equal(g.ballTrail.length, 0);
  assert.equal(calls.filter(c => c.method === 'arc').length, 0);
  assert.equal(stack.length, 0, 'balanced canvas state');
}
const html = fs.readFileSync('docs/index.html', 'utf8');
const css = fs.readFileSync('docs/styles.css', 'utf8');
assert.doesNotMatch(css, /#game-canvas\s*\{[^}]*filter\s*:/, 'CSS must not transform the selected canvas palette');
assert.match(html, /<canvas[^>]*id="game-canvas"[^>]*aria-hidden="true"/);
assert.doesNotMatch(html.match(/<canvas[^>]*id="game-canvas"[^>]*>/)[0], /tabindex/);
for (const difficulty of ['easy', 'normal', 'hard']) {
  assert.match(html, new RegExp(`<button[^>]*id="btn-diff-${difficulty}"`));
}
console.log('Canvas regression passed: all difficulties/palettes, past-only trail and accessibility markup.');
