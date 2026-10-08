// Optional Chrome verification; use the same NODE_PATH as layout-browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve('docs', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(path.resolve('docs') + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.STT_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ hasTouch: true });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.gameEngine);
    assert.ok(await page.locator('#mobile-settings-panel').isVisible());
    assert.equal(await page.locator('#screen-welcome legend h3').count(), 0);
    assert.deepEqual(await page.locator('#screen-welcome fieldset').evaluateAll(groups => groups.map(group => ({
      first: group.firstElementChild.tagName,
      caption: group.firstElementChild.textContent.trim(),
      previous: group.previousElementSibling.tagName,
      heading: group.previousElementSibling.textContent.trim(),
    }))), [
      { first: 'LEGEND', caption: '画面の見やすさ', previous: 'H3', heading: '画面の見やすさ' },
      { first: 'LEGEND', caption: '音声案内', previous: 'H3', heading: '音声案内' },
    ]);
    for (const name of ['画面の見やすさ', '音声案内']) assert.equal(await page.getByRole('group', { name, exact: true }).count(), 1);
    const slider = page.getByRole('slider', { name: '内蔵音声の速さ', exact: true });
    await page.selectOption('#select-speech-mode', 'builtin');
    assert.ok(await slider.isEnabled());
    await slider.fill('1.5');
    assert.equal(await page.locator('#lbl-speech-rate-val').textContent(), '1.5');
    assert.equal(await slider.getAttribute('aria-describedby'), 'speech-rate-value speech-rate-hint');
    await page.click('#btn-test-speech');
    await page.selectOption('#select-speech-mode', 'screen-reader');
    assert.ok(await slider.isDisabled());
    await page.click('#btn-test-speech');
    await page.waitForFunction(() => document.getElementById('sr-announcer').textContent.includes('音声案内のテスト'));
    assert.match(await page.locator('#sr-announcer').textContent(), /音声案内のテスト/);
    const checkbox = page.getByRole('checkbox', { name: 'スマホを傾けてラケットを左右に動かす', exact: true });
    assert.ok(await checkbox.isChecked());
    await checkbox.uncheck();
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    assert.ok(await checkbox.isChecked());
    await checkbox.uncheck();
    await page.reload();
    await page.waitForFunction(() => window.gameEngine);
    assert.equal(await slider.inputValue(), '1.5');
    assert.equal(await page.locator('#lbl-speech-rate-val').textContent(), '1.5');
    assert.ok(await slider.isDisabled());
    await page.selectOption('#select-speech-mode', 'builtin');
    assert.ok(await slider.isEnabled());
    const snapshot = await page.locator('#screen-welcome').ariaSnapshot();
    assert.match(snapshot, /heading "画面の見やすさ" \[level=3\]/);
    assert.match(snapshot, /heading "内蔵音声の速さ" \[level=4\]/);
    assert.match(snapshot, /slider "内蔵音声の速さ": "1\.5"/);
    // Existing tilt restoration runs on the audio/start button, not page load.
    await page.click('#btn-enable-audio');
    assert.equal(await page.locator('#chk-use-tilt').isChecked(), false);
    console.log('Passed native groups, accessible headings/slider/checkbox, rate display, speech modes, speech test, tilt toggle and saved settings restoration.');
    const desktop = await browser.newPage({ hasTouch: false });
    // Chrome exposes DeviceMotionEvent even on some desktops; explicitly model
    // the existing non-touch/non-sensor branch without changing production code.
    await desktop.addInitScript(() => {
      delete window.DeviceMotionEvent;
      delete window.ontouchstart;
    });
    await desktop.goto('http://127.0.0.1:' + server.address().port);
    await desktop.waitForFunction(() => window.gameEngine);
    assert.equal(await desktop.locator('#mobile-settings-panel').isVisible(), false);
    console.log('Passed existing mobile and simulated non-touch/non-sensor visibility branches.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
