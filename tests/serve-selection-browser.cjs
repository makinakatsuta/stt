// Dedicated touch/layout regression for the native serve choices.
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
    const page = await browser.newPage({ hasTouch: true, isMobile: true });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.gameEngine);
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    async function prepare() {
      await page.evaluate(() => {
        gameEngine.stopLoop(); gameEngine.clearGameplayTasks();
        gameEngine.mode = 'cpu'; gameEngine.role = 1; gameEngine.serverRole = 1;
        gameEngine.isGameplayPaused = false;
        gameEngine.changeScreen('play'); gameEngine.prepareServeSequence(); gameEngine.draw();
      });
    }
    const artifactDir = process.env.STT_SERVE_ARTIFACTS || path.join(require('node:os').tmpdir(), 'stt-serve-layout');
    fs.mkdirSync(artifactDir, { recursive: true });
    let cases = 0;
    for (const [width, height] of [[320,568], [375,667], [390,844], [568,320], [667,375], [844,390], [1280,720]]) {
      await page.setViewportSize({width,height});
      for (const size of ['standard', 'large', 'extra-large', 'largest']) for (const palette of ['default', 'white-on-black', 'black-on-white', 'yellow-on-black']) {
        await page.evaluate(() => gameEngine.changeScreen('welcome'));
        await page.selectOption('#select-text-size', size);
        await page.selectOption('#select-contrast', palette);
        await page.selectOption('#select-speech-mode', 'builtin');
        await prepare();
        const label = width + 'x' + height + '/' + size + '/' + palette;
        const metrics = await page.locator('#serve-selection').evaluate(group => {
          const rect = group.getBoundingClientRect();
          return { display: getComputedStyle(group).display, width: rect.width,
            gap: parseFloat(getComputedStyle(group).columnGap), overflow: document.documentElement.scrollWidth > innerWidth,
            buttons: [...group.children].map(button => {
              const r = button.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(button);
              return {name: button.textContent, x:r.x, y:r.y, width:r.width, height:r.height,
                clipped: button.scrollWidth > button.clientWidth || button.scrollHeight > button.clientHeight,
                textInside: [...range.getClientRects()].every(text => text.left >= r.left && text.right <= r.right + 1 && text.top >= r.top && text.bottom <= r.bottom + 1)};
            }) };
        });
        assert.equal(metrics.display, 'grid', label);
        assert.equal(metrics.overflow, false, label);
        assert.deepEqual(metrics.buttons.map(b => b.name), ['サーブ1', 'サーブ2', 'サーブ3']);
        for (let i=0; i<3; i++) {
          const b = metrics.buttons[i];
          assert.ok(Math.abs(b.width - (metrics.width - 2*metrics.gap)/3) < 1, label + ': equal thirds');
          assert.ok(Math.abs(b.y - metrics.buttons[0].y) < 1, label + ': one row');
          assert.ok(b.height >= 52 && !b.clipped && b.textInside, label + ': full touch target and text');
          if (i) assert.ok(b.x > metrics.buttons[i-1].x + metrics.buttons[i-1].width, label + ': left to right gap');
        }
        assert.equal(await page.locator('#btn-quit-game').isEnabled(), true);
        const tree = await page.getByRole('group', {name:'次のサーブを選択'}).ariaSnapshot();
        assert.ok(tree.indexOf('button "サーブ1"') < tree.indexOf('button "サーブ2"') && tree.indexOf('button "サーブ2"') < tree.indexOf('button "サーブ3"'), label + ': accessibility order');
        assert.ok(!tree.includes('[disabled]'));
        if (palette === 'default' && ['standard','largest'].includes(size)) await page.screenshot({path: path.join(artifactDir, 'serve-' + width + '-' + height + '-' + size + '.png'), fullPage:true});
        // Actual touchscreen activation, with built-in speech and no screen reader.
        for (const type of [1,2,3]) {
          if (type !== 1) await prepare();
          await page.getByRole('button', {name:'サーブ'+type, exact:true}).tap();
          assert.deepEqual(await page.evaluate(() => ({type:gameEngine.selectedServeType, state:gameEngine.state, active:gameEngine.ball.active})), {type, state:'PRE_SERVE_READY', active:false});
          assert.equal(await page.locator('#serve-selection').isVisible(), false);
          assert.equal(await page.locator('#serve-selection button:disabled').count(), 3);
        }
        await page.getByRole('button', {name:'中断メニュー', exact:true}).tap();
        assert.ok(await page.getByRole('alertdialog').isVisible());
        await page.getByRole('button', {name:'再開', exact:true}).tap();
        assert.equal(await page.getByRole('alertdialog').isVisible(), false);
        assert.equal(await page.evaluate(() => gameEngine.state), 'PRE_SERVE_READY');
        await page.locator('#game-canvas').tap();
        assert.equal(await page.evaluate(() => gameEngine.state), 'PRE_SERVE_HEARD', label + ': canvas tap still prepares serve');
        cases++;
      }
    }
    await page.evaluate(() => {gameEngine.clearGameplayTasks();gameEngine.setGameplayChromeHidden(false);});
    console.log('Passed ' + cases + ' serve Grid layouts: equal three columns, 52px targets, enlarged text, accessibility order, touchscreen selection, hidden controls, pause/resume and canvas tap. Screenshots: ' + artifactDir);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
