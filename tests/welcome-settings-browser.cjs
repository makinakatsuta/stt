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

async function verifyRateControls(page) {
  const ax = await page.context().newCDPSession(page);
  const slider = page.getByRole('slider', { name: '内蔵音声の速さ', exact: true });
  const slower = page.getByRole('button', { name: '内蔵音声を遅くする', exact: true });
  const faster = page.getByRole('button', { name: '内蔵音声を速くする', exact: true });
  async function check(rate) {
    const formatted = rate.toFixed(1);
    assert.ok(await slider.isEnabled());
    assert.equal(Number(await slider.inputValue()), rate);
    assert.equal(await page.locator('#lbl-speech-rate-val').textContent(), formatted);
    assert.equal(await slider.getAttribute('aria-valuetext'), formatted + '倍');
    assert.equal(await slower.isDisabled(), rate === 0.5);
    assert.equal(await faster.isDisabled(), rate === 2.0);
    const settings = await page.evaluate(async () => {
      const { narrator } = await import(document.querySelector('script[src*="app.js"]').src.replace(/app\.js.*$/, 'js/speech-system.js?v=3.31.50'));
      return { rate: narrator.speechRate, saved: localStorage.getItem('stt_speech_rate') };
    });
    assert.equal(settings.rate, rate);
    assert.equal(settings.saved, formatted);
    const { nodes } = await ax.send('Accessibility.getFullAXTree');
    const accessibleSlider = nodes.find(node => node.role?.value === 'slider' && node.name?.value === '内蔵音声の速さ');
    assert.ok(Math.abs(accessibleSlider.value.value - rate) < 0.000001);
    // Native range exposes a numeric value in this Chrome build; the related
    // description carries the formatted multiplier, with aria-valuetext checked above.
    assert.ok(accessibleSlider.description.value.includes(formatted + '倍'));
    assert.equal(accessibleSlider.properties.find(property => property.name === 'valuemin').value.value, 0.5);
    assert.equal(accessibleSlider.properties.find(property => property.name === 'valuemax').value.value, 2);
    assert.ok(!accessibleSlider.properties.some(property => property.name === 'disabled' && property.value.value));
    for (const [name, disabled] of [['内蔵音声を遅くする', rate === 0.5], ['内蔵音声を速くする', rate === 2.0]]) {
      const button = nodes.find(node => node.role?.value === 'button' && node.name?.value === name);
      assert.ok(button);
      assert.equal(button.properties.some(property => property.name === 'disabled' && property.value.value), disabled);
      assert.ok(button.description.value.includes(formatted + '倍'));
    }
    const tree = await page.locator('.speech-rate-panel').ariaSnapshot();
    assert.ok(tree.includes('slider "内蔵音声の速さ": "' + String(rate) + '"'));
    assert.ok(tree.includes('button "内蔵音声を遅くする"' + (rate === 0.5 ? ' [disabled]' : '')));
    assert.ok(tree.includes('button "内蔵音声を速くする"' + (rate === 2.0 ? ' [disabled]' : '')));
  }
  for (const mode of ['builtin', 'screen-reader']) {
    await page.selectOption('#select-speech-mode', mode);
    await slider.fill('1'); await check(1.0);
    await faster.click(); await check(1.1);
    await slower.click(); await check(1.0);
    // Assistive activation can send a click without touch/pointer events.
    await faster.dispatchEvent('click', { detail: 0 }); await check(1.1);
    await slower.dispatchEvent('click', { detail: 0 }); await check(1.0);
    await faster.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: false }); await check(1.1);
    await faster.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true }); await check(1.1);
    await slower.dispatchEvent('keydown', { key: ' ', code: 'Space', repeat: false }); await check(1.0);
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
      await faster.tap(); await check(1.1);
      await slower.tap(); await check(1.0);
    }
    await slider.fill('0.5'); await check(0.5);
    await slower.dispatchEvent('keydown', { key: 'Enter', repeat: false }); await check(0.5);
    await slider.press('ArrowLeft'); await check(0.5);
    await faster.click(); await check(0.6);
    await slider.fill('2'); await check(2.0);
    await faster.dispatchEvent('keydown', { key: ' ', repeat: false }); await check(2.0);
    await slider.press('ArrowRight'); await check(2.0);
    await slower.click(); await check(1.9);
    await slider.press('Home'); await check(0.5);
    await slider.press('ArrowRight'); await check(0.6);
    await slider.press('End'); await check(2.0);
    await slower.focus(); await slower.press('Enter'); await check(1.9);
    await slower.press('Space'); await check(1.8);
    await slower.press('Tab'); assert.ok(await faster.evaluate(el => el === document.activeElement));
    await faster.press('Enter'); await check(1.9);
    await page.reload(); await page.waitForFunction(() => window.gameEngine);
    assert.equal(await page.locator('#select-speech-mode').inputValue(), mode); await check(1.9);
    await page.selectOption('#select-speech-mode', mode === 'builtin' ? 'screen-reader' : 'builtin'); await check(1.9);
    assert.equal(await slider.getAttribute('aria-describedby'), 'speech-rate-value speech-rate-hint');
    for (const button of [slower, faster]) {
      assert.equal(await button.getAttribute('aria-describedby'), 'speech-rate-value');
      const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.STT_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
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
    assert.ok(await slider.isEnabled());
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
    assert.ok(await slider.isEnabled());
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
    await page.reload();
    await page.waitForFunction(() => window.gameEngine);
    await verifyRateControls(page);
    const desktop = await browser.newPage({ hasTouch: false, viewport: { width: 1280, height: 720 } });
    // Chrome exposes DeviceMotionEvent even on some desktops; explicitly model
    // the existing non-touch/non-sensor branch without changing production code.
    await desktop.addInitScript(() => {
      delete window.DeviceMotionEvent;
      delete window.ontouchstart;
    });
    await desktop.goto('http://127.0.0.1:' + server.address().port);
    await desktop.waitForFunction(() => window.gameEngine);
    assert.equal(await desktop.locator('#mobile-settings-panel').isVisible(), false);
    await verifyRateControls(desktop);
    console.log('Passed rate controls in both modes, boundaries, synchronization, keyboard, accessibility tree, reload and desktop/mobile layouts.');
    console.log('Passed existing mobile and simulated non-touch/non-sensor visibility branches.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
