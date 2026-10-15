// Dedicated touch/layout regression for the native serve choices.
// Optional Chrome verification; use the same NODE_PATH as layout-browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const originalCSS = require('node:child_process').execFileSync('git', ['show', 'HEAD:docs/styles.css'], { encoding: 'utf8' });
// This historical layout comparison only applies while the former layout is
// still HEAD. After it lands, use HEAD equality plus the geometry assertions.
const baselineHasCompactPause = originalCSS.includes('#screen-play #current-server {');
const previousMobileCSS = originalCSS + `
@media (max-width:768px) {
  #screen-play #game-input-area {display:grid;grid-template-columns:minmax(0,1fr);gap:8px;}
  #screen-play .play-controls {display:contents!important;}
  #screen-play #btn-quit-game {grid-row:1;justify-self:end;width:auto;min-width:44px;min-height:44px;margin:0;padding:6px 10px;font-size:.8rem;}
  #screen-play .game-play-layout {grid-row:2;margin-top:0;}
  #screen-play #serve-selection {grid-row:3;}
}`;
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
    await page.evaluate(() => {
      window.pauseTestActions = 0;
      const action = gameEngine.handleActionInput.bind(gameEngine);
      gameEngine.handleActionInput = (...args) => { window.pauseTestActions++; return action(...args); };
    });
    async function inspectPauseControl(label, mobile, fallback) {
      const metrics = await page.evaluate(() => {
        const button = document.getElementById('btn-quit-game');
        const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height}; };
        const r = rect(button);
        const range = document.createRange(); range.selectNodeContents(button);
        const server = document.getElementById('current-server');
        const serverRange = document.createRange(); serverRange.selectNodeContents(server);
        const sr = rect(server);
        return { button:r, server:sr, referee:rect(document.getElementById('referee-message')),
          canvas:rect(document.getElementById('canvas-container')),
          info: ['.scoreboard', '#referee-message', '#play-instructions'].map(s => document.querySelector(s)).filter(el => el.getClientRects().length).map(rect),
          lines:range.getClientRects().length,
          serverTextInside:[...serverRange.getClientRects()].every(t => t.left >= sr.left && t.right <= sr.right + 1 && t.top >= sr.top && t.bottom <= sr.bottom + 1),
          textInside: [...range.getClientRects()].every(t => t.left >= r.left && t.right <= r.right + 1 && t.top >= r.top && t.bottom <= r.bottom + 1),
          font: parseFloat(getComputedStyle(button).fontSize), root: parseFloat(getComputedStyle(document.documentElement).fontSize),
          position:getComputedStyle(button).position,
          overflow:document.documentElement.scrollWidth > innerWidth,
          count:document.querySelectorAll('#btn-quit-game').length };
      });
      assert.equal(metrics.count, 1, label + ': unique native pause button');
      assert.ok(metrics.textInside && metrics.serverTextInside && !metrics.overflow, label + ': full text and no horizontal overflow');
      if (mobile) {
        const b = metrics.button;
        assert.ok(b.width >= 44 && b.height >= 44, label + ': 44px minimum target');
        assert.ok(Math.abs(b.right - metrics.referee.right) < 1, label + ': pause on right edge');
        if (fallback) assert.ok(b.top >= metrics.server.bottom + 7.9, label + ': enlarged narrow-screen fallback');
        else assert.ok(b.left >= metrics.server.right + 7.9 && Math.abs((b.top + b.bottom - metrics.server.top - metrics.server.bottom) / 2) < 1, label + ': server and pause share one centered row');
        assert.ok(metrics.referee.top >= Math.max(b.bottom, metrics.server.bottom) + 7.9 && metrics.canvas.top >= metrics.referee.bottom + 7.9, label + ': status, referee and canvas do not overlap');
        assert.equal(metrics.lines, 1, label + ': one-line pause name');
        assert.ok(metrics.font < metrics.root && metrics.position !== 'fixed', label + ': compact scalable text without fixed positioning');
        assert.ok((await page.getByRole('application', {name:'プレイ操作'}).ariaSnapshot()).includes('button "中断メニュー"'), label + ': application and native button remain in accessibility tree');
        if (!baselineHasCompactPause && label.endsWith('/standard/default')) {
          const top = () => page.locator('#game-canvas').evaluate(el => el.getBoundingClientRect().top + scrollY);
          const currentTop = await top();
          await page.evaluate(css => {
            document.querySelector('link[href^="styles.css"]').disabled = true;
            const style = document.createElement('style'); style.id = 'pause-previous'; style.textContent = css;
            document.head.append(style);
          }, previousMobileCSS);
          assert.ok(await top() > currentTop + 20, label + ': canvas moves upward compared with independent pause row');
          await page.evaluate(() => {
            document.getElementById('pause-previous').remove();
            document.querySelector('link[href^="styles.css"]').disabled = false;
          });
        }
      } else {
        // Compare every play element's geometry and computed appearance with HEAD.
        const capture = () => page.locator('#screen-play, #screen-play *').evaluateAll(nodes => nodes.map(el => {
          const r = el.getBoundingClientRect(), css = getComputedStyle(el);
          return {id:el.id, rect:[r.x,r.y,r.width,r.height], styles:[...css].map(k => [k, css.getPropertyValue(k)])};
        }));
        const current = await capture();
        const before = await page.screenshot();
        await page.evaluate(css => {
          document.querySelector('link[href^="styles.css"]').disabled = true;
          const style = document.createElement('style'); style.id = 'pause-baseline';
          style.textContent = css + '\n*, *::before, *::after { animation: none !important; transition: none !important; }';
          document.head.append(style);
        }, originalCSS);
        assert.deepEqual(await capture(), current, label + ': desktop geometry and computed appearance unchanged');
        assert.ok(before.equals(await page.screenshot()), label + ': desktop screenshot unchanged');
        await page.evaluate(() => {
          document.getElementById('pause-baseline').remove();
          document.querySelector('link[href^="styles.css"]').disabled = false;
        });
      }
    }
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
    for (const [width, height] of [[320,568], [360,640], [375,667], [390,844], [430,932], [768,1024], [568,320], [667,375], [768,430], [769,1024], [844,390], [1280,720], [1440,900]]) {
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
        await inspectPauseControl(label, width <= 768, width <= 400 && size === 'largest');
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
        const actionsBeforePause = await page.evaluate(() => pauseTestActions);
        await page.keyboard.press('Tab');
        await page.getByRole('button', {name:'中断メニュー', exact:true}).focus();
        assert.equal(await page.locator(':focus').getAttribute('id'), 'btn-quit-game');
        assert.ok(await page.locator('#btn-quit-game').evaluate(el => getComputedStyle(el).outlineStyle !== 'none'), label + ': keyboard focus indicator');
        await page.getByRole('button', {name:'中断メニュー', exact:true}).tap();
        assert.ok(await page.getByRole('alertdialog').isVisible());
        assert.equal(await page.locator(':focus').getAttribute('id'), 'btn-cancel-quit');
        await page.evaluate(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', {key:' ', code:'Space', bubbles:true}));
          document.dispatchEvent(new KeyboardEvent('keyup', {key:' ', code:'Space', bubbles:true}));
        });
        assert.equal(await page.evaluate(() => pauseTestActions), actionsBeforePause, label + ': pause tap and paused Space never trigger gameplay');
        await page.getByRole('button', {name:'再開', exact:true}).tap();
        assert.equal(await page.getByRole('alertdialog').isVisible(), false);
        assert.ok(await page.evaluate(() => !document.activeElement.closest('#quit-confirm-overlay')), label + ': focus restored outside dialog');
        assert.equal(await page.evaluate(() => gameEngine.state), 'PRE_SERVE_READY');
        await page.locator('#game-canvas').tap();
        assert.equal(await page.evaluate(() => gameEngine.state), 'PRE_SERVE_HEARD', label + ': canvas tap still prepares serve');
        assert.equal(await page.evaluate(() => pauseTestActions), actionsBeforePause + 1, label + ': canvas tap triggers exactly one action');
        cases++;
      }
      console.log('Viewport passed: ' + width + 'x' + height + ' (' + cases + ' cases)');
    }
    await page.getByRole('button', {name:'中断メニュー', exact:true}).tap();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', {name:'TOPに戻る', exact:true}).tap();
    assert.ok(await page.locator('#screen-menu').isVisible(), 'pause TOP returns to menu');
    await page.evaluate(() => {gameEngine.clearGameplayTasks();gameEngine.setGameplayChromeHidden(false);});
    console.log('Passed ' + cases + ' serve Grid layouts: equal three columns, 52px targets, enlarged text, accessibility order, touchscreen selection, hidden controls, pause/resume and canvas tap. Screenshots: ' + artifactDir);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
