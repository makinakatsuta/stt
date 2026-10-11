// Use the same external NODE_PATH/Chrome as welcome-settings-browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve('docs', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(path.resolve('docs') + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.STT_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem('stt_speech_mode', 'screen-reader');
      localStorage.setItem('stt_speech_rate', '1.7');
      window.mockSpoken = [];
      const synth = { speaking: false, pending: false, paused: false,
        getVoices: () => [{ name: 'Google 日本語', lang: 'ja-JP', default: true, localService: true, voiceURI: 'mock-ja' }],
        cancel() { this.pending = this.speaking = false; },
        speak(u) { window.mockSpoken.push(u); this.pending = true; },
        resume() { this.paused = false; }
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synth });
      window.SpeechSynthesisUtterance = function(text) { this.text = text; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.copied = text; }
      } });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base + '/speech-diagnostics.html');
    await page.getByRole('heading', { name: 'STT 開発者用音声診断', exact: true }).waitFor();
    assert.equal(await page.locator('#test-a').isDisabled(), true);
    await page.getByRole('button', { name: '診断を開始する', exact: true }).tap();
    await page.getByLabel('実機の情報', { exact: false }).fill('Android mock; TalkBack off');
    for (const kind of ['a', 'b', 'a', 'b']) {
      await page.locator(`#test-${kind}`).tap();
      await page.evaluate(() => {
        const u = window.mockSpoken.at(-1);
        speechSynthesis.pending = false; speechSynthesis.speaking = true; u.onstart({});
        speechSynthesis.speaking = false; u.onend({ charIndex: 13, elapsedTime: 2 });
      });
      await page.getByLabel('実際に聞こえた音声').selectOption('complete');
      await page.getByRole('button', { name: '選択したテストの聴取結果を記録' }).tap();
    }
    await page.getByRole('button', { name: '現在の音声状態を記録' }).tap();
    await page.locator('#copy').tap();
    const copied = await page.evaluate(() => window.copied);
    assert.equal(copied, await page.locator('#report').inputValue());
    const report = JSON.parse(copied.split('\n').slice(1).join('\n'));
    assert.deepEqual(report.tests.map(t => [t.kind, t.speakCalls, t.onstart, t.onend, t.heard]), [
      ['A', 1, 1, 1, 'complete'], ['B', 1, 1, 1, 'complete'],
      ['A', 1, 1, 1, 'complete'], ['B', 1, 1, 1, 'complete']
    ]);
    assert.equal(report.metadata.environment, 'Android mock; TalkBack off');
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('stt_speech_mode'), localStorage.getItem('stt_speech_rate')]), ['screen-reader', '1.7']);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; });
    await page.locator('#copy').tap();
    assert.match(await page.locator('#copy-status').textContent(), /自動コピーが利用できません/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'report');
    assert.equal(await page.locator('#report').evaluate(el => el.selectionEnd - el.selectionStart), (await page.locator('#report').inputValue()).length);
    const ax = await page.locator('main').ariaSnapshot();
    for (const text of ['heading "STT 開発者用音声診断"', 'button "A：STT経由でテスト音声を発声"',
      'button "B：Web Speech API直接でテスト音声を発声"', 'textbox "診断結果（テキスト）"',
      'combobox "結果を記録するテスト"']) assert.ok(ax.includes(text), text);
    await page.setViewportSize({ width: 320, height: 568 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Actual keyboard activation and a missing-event B test can be manually stopped.
    await page.locator('#test-b').focus(); await page.keyboard.press('Enter');
    await page.locator('#stop').tap();
    const stopped = JSON.parse((await page.locator('#report').inputValue()).split('\n').slice(1).join('\n'));
    assert.equal(stopped.current.directUtteranceRemaining, false);
    assert.ok(stopped.events.some(e => e.type === 'stop' && e.reason === 'diagnostic-user-stop'));
    // A再クリックが事前cancelで参照を消すことなく、通常ボタンと同じ拒否を記録する。
    await page.locator('#test-a').tap();
    const aCalls = await page.evaluate(() => window.mockSpoken.length);
    await page.locator('#test-a').tap();
    const repeated = JSON.parse((await page.locator('#report').inputValue()).split('\n').slice(1).join('\n'));
    assert.equal(await page.evaluate(() => window.mockSpoken.length), aCalls);
    assert.equal(repeated.tests.at(-1).rejected[0].reason, 'test-utterance-remains');
    assert.equal(repeated.events.filter(e => e.reason === `diagnostic-before-test:${repeated.tests.at(-1).id}:A`).length, 0);
    await page.evaluate(() => { speechSynthesis.pending = false; window.mockSpoken.at(-1).onend({}); });
    await page.locator('#test-a').tap();
    assert.equal(await page.evaluate(() => window.mockSpoken.length), aCalls + 1);
    await page.goto(base + '/');
    assert.equal(await page.locator('#test-a, #test-b, #report').count(), 0);
    assert.equal(await page.locator('a[href*="speech-diagnostics"]').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('Passed diagnostic page touch/keyboard, A/B repetition, labels, copy/fallback, stop, narrow layout, settings isolation and hidden normal UI. Android engine/TalkBack audio remains unverified.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
