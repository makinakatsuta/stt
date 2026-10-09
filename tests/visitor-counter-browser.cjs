// Optional real Chrome checks, using the same NODE_PATH as layout-browser.cjs.
// All site assets and counter requests are intercepted: no production increments.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const origin = 'https://soundtabletennis.com';
const api = 'https://countapi.mileshilliard.com/api/v1/';
const artifacts = path.resolve('artifacts/visitor-counter');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.STT_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    async function scenario(mode, mobile = false) {
      const context = await browser.newContext({ viewport: { width: mobile ? 320 : 1280, height: mobile ? 568 : 720 }, isMobile: mobile, hasTouch: mobile });
      const calls = [];
      const errors = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.href.startsWith(api)) {
          const action = url.pathname.split('/')[3];
          calls.push(action);
          if (mode === 'error' || (mode === 'recover' && calls.length === 1)) return route.abort('failed');
          if (mode === 'timeout' && calls.length === 1) {
            // Beyond the production 10s deadline; the later GET is not stalled.
            await new Promise(resolve => setTimeout(resolve, 11000));
            return route.abort('timedout').catch(() => {});
          }
          return route.fulfill({ json: { key: 'soundtabletennis-com-total-visitors', value: 123456789 }, headers: { 'Access-Control-Allow-Origin': origin } });
        }
        if (url.origin !== origin) return route.abort();
        const file = path.resolve('docs', '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
        if (!file.startsWith(path.resolve('docs') + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
        return route.fulfill({ body: fs.readFileSync(file), contentType: { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.m4a': 'audio/mp4' }[path.extname(file)] || 'application/octet-stream' });
      });
      if (mode === 'blocked') await context.addInitScript(() => {
        for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { get() { throw new Error('blocked storage'); } });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(() => window.gameEngine);
      const initialFocus = await page.evaluate(() => document.activeElement.id);
      if (mode === 'error') {
        await page.waitForFunction(() => document.getElementById('visitor-counter-status').textContent.includes('再読み込み'));
        assert.deepEqual(calls, ['hit', 'get', 'get']);
        assert.ok(await page.locator('#visitor-counter').isVisible());
        assert.ok(await page.locator('#total-visitor-row').isHidden());
      } else {
        await page.waitForFunction(() => !document.getElementById('total-visitor-row').hidden, null, { timeout: 20000 });
        assert.equal(await page.locator('#total-visitor-count').textContent(), '123,456,789');
        assert.deepEqual(calls, mode === 'recover' || mode === 'timeout' ? ['hit', 'get'] : mode === 'blocked' ? ['get'] : ['hit']);
        assert.equal(await page.locator('#visitor-number-row').isVisible(), mode === 'normal');
      }
      // The region has a name and plain text; it is outside live notification paths.
      const snapshot = await page.getByRole('region', { name: '訪問者情報', exact: true }).ariaSnapshot();
      assert.match(snapshot, /訪問者情報/);
      assert.match(snapshot, mode === 'error' ? /取得できませんでした/ : /123,456,789/);
      assert.equal(await page.locator('#visitor-counter').evaluate(el => !!el.closest('[aria-live], [role="status"], [role="alert"]')), false);
      assert.equal(await page.locator('#visitor-counter [tabindex], #visitor-counter [aria-live]').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), initialFocus);
      assert.equal(await page.locator('#sr-announcer').textContent(), '');
      for (const width of [1280, 390, 320]) for (const size of [1, 1.25, 1.5, 2]) {
        await page.setViewportSize({ width, height: 720 });
        await page.evaluate(size => document.documentElement.style.fontSize = `${size * 100}%`, size);
        assert.deepEqual(await page.locator('#visitor-counter').evaluate(el => {
          const rect = el.getBoundingClientRect();
          return { fits: rect.left >= 0 && rect.right <= innerWidth + 1, wraps: el.scrollWidth <= el.clientWidth + 1 };
        }), { fits: true, wraps: true }, `${mode}/${width}/${size}`);
      }
      fs.mkdirSync(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, `${mode}-320-200.png`), fullPage: true });
      const beforeReload = calls.length;
      if (mode !== 'blocked') {
        await page.reload();
        await page.waitForFunction(() => window.gameEngine);
        await page.waitForFunction(() => document.getElementById('visitor-counter-status').textContent.includes('再読み込み') || !document.getElementById('total-visitor-row').hidden);
        assert.ok(calls.slice(beforeReload).every(action => action === 'get'));
      }
      await page.click('#btn-enable-audio');
      assert.ok(await page.locator('#screen-menu').isVisible());
      assert.deepEqual(errors, []);
      await context.close();
    }
    await scenario('normal');
    await scenario('error');
    await scenario('recover', true);
    await scenario('blocked', true);
    await scenario('timeout');
    console.log('Chrome counter checks passed: mocked success/error/recovery/storage/10s timeout, read-only reloads, accessibility structure, passive updates, 60 reflow combinations and game bootstrap. Android hardware/screen readers not tested.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
