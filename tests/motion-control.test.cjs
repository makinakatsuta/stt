const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../docs/js/game-engine.js'), 'utf8');
const start = source.indexOf('  handleDeviceMotion(event) {');
assert.ok(start >= 0);
const method = source.slice(start, source.indexOf('\n  /**', start));
const constants = source.match(/^const MOTION_(?:FILTER_ALPHA|START_DEADZONE|STOP_DEADZONE) = .*;$/gm).join('\n');
let checks = 0;
// Gravity-inclusive readings for a stationary phone with its screen-left edge down.
for (const [angle, x, y] of [[0, 4.9, 0], [90, 0, -4.9], [180, -4.9, 0], [270, 0, 4.9], [-90, 0, 4.9]]) {
  for (const legacy of [false, true]) {
    const context = vm.createContext({screen: legacy ? {} : {orientation: {angle}}, window: {orientation: legacy ? angle : 0}});
    const handler = vm.runInContext(constants + '\n({' + method + '}).handleDeviceMotion', context);
    const state = {useTilt: true, filteredMotionAccelX: 0, motionDirection: 0, keys: {}};
    const feed = (x, y) => {for (let i = 0; i < 40; i++) handler.call(state, {accelerationIncludingGravity: {x, y, z: 8.49}});};
    feed(x, y);
    assert.equal(state.keys.ArrowLeft, true, `left: ${angle}, legacy=${legacy}`);
    assert.equal(state.keys.ArrowRight, false);
    feed(-x, -y);
    assert.equal(state.keys.ArrowRight, true, `right: ${angle}, legacy=${legacy}`);
    assert.equal(state.keys.ArrowLeft, false);
    feed(0, 0);
    assert.equal(state.keys.ArrowLeft, false);
    assert.equal(state.keys.ArrowRight, false);
    assert.equal(state.tiltSpeed, 0);
    feed(0.5, 0.5);
    assert.equal(state.motionDirection, 0);
    state.useTilt = false;
    feed(x, y);
    assert.equal(state.motionDirection, 0);
    checks++;
  }
}
console.log(`Passed ${checks} orientation/API combinations: left, right, stop, tremor, disabled.`);
