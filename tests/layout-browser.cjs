// Optional real-browser regression: npm install playwright in a temporary tools
// directory, set NODE_PATH to its node_modules, then node tests/layout-browser.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const sizes = ['standard', 'large', 'extra-large', 'largest'];
const palettes = ['default', 'white-on-black', 'black-on-white', 'yellow-on-black'];
const viewports = [[1440, 900], [1280, 720], [768, 1024], [390, 844], [320, 568]];
const artifactDir = process.env.STT_LAYOUT_ARTIFACTS || path.join(require('node:os').tmpdir(), 'stt-layout-results');
fs.mkdirSync(artifactDir, { recursive: true });
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
async function inspect(page, label) {
  await page.waitForTimeout(30);
  const problems = await page.evaluate(() => {
    const errors = [];
    if (document.documentElement.scrollWidth > innerWidth + 2) errors.push('document overflow ' + document.documentElement.scrollWidth);
    const visible = el => el.getClientRects().length && !el.closest('.sr-only,[hidden],.hidden');
    for (const el of document.querySelectorAll('button, .select-control, .game-card, .quit-confirm-dialog, .match-result-overlay, .menu-title, .menu-desc, .description, .score-panel')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > innerWidth + 1) errors.push((el.id || el.className) + ' outside viewport');
      if (el.scrollWidth > el.clientWidth + 2) errors.push((el.id || el.className) + ' clipped horizontally');
    }
    for (const control of document.querySelectorAll('.select-control')) {
      if (!visible(control)) continue;
      const select = control.querySelector('select');
      const mirror = [...control.querySelectorAll('.select-value > span')].filter(visible);
      if (mirror.length !== 1 || mirror[0].textContent !== select.selectedOptions[0].textContent) errors.push(select.id + ' value mismatch');
    }
    for (const btn of document.querySelectorAll('.btn-menu')) {
      if (!visible(btn)) continue;
      const children = [...btn.children].filter(visible).map(el => el.getBoundingClientRect());
      for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
        const a = children[i], b = children[j];
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) errors.push(btn.id + ' overlapping text');
      }
    }
    return errors;
  });
  assert.deepEqual(problems, [], label + ': ' + problems.join(', '));
}
async function inspectWelcome(page, label) {
  const metrics = await page.evaluate(() => {
    const title = document.getElementById('welcome-title');
    const prose = document.querySelector('#screen-welcome > .description');
    const card = document.getElementById('screen-welcome');
    const css = getComputedStyle(card);
    return {
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      body: parseFloat(getComputedStyle(prose).fontSize),
      title: parseFloat(getComputedStyle(title).fontSize),
      proseWidth: prose.getBoundingClientRect().width,
      available: card.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
      gap: prose.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
    };
  });
  assert.equal(metrics.body, metrics.root, label + ': selected body size preserved');
  assert.ok(metrics.title >= metrics.body * 1.24 && metrics.title <= metrics.body * 1.51, label + ': heading hierarchy');
  assert.ok(Math.abs(metrics.proseWidth - Math.min(metrics.available, metrics.body * 40)) < 2, label + ': prose uses available width with bounded line length');
  assert.ok(metrics.gap >= 0, label + ': heading and prose do not overlap');
  await page.getByRole('heading', { name: 'ようこそ、サウンドテーブルテニスへ', exact: true }).count().then(count => assert.equal(count, 1));
  for (const name of ['配色・コントラスト', '文字の大きさ', '読み上げ方式']) {
    assert.equal(await page.getByRole('combobox', { name, exact: true }).count(), 1, label + ': native accessible select ' + name);
  }
  for (const control of await page.locator('#screen-welcome select, #screen-welcome button, #screen-welcome input').all()) {
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    assert.ok(await control.evaluate(el => {
      const r = el.getBoundingClientRect();
      return document.activeElement === el && r.bottom > 0 && r.top < innerHeight;
    }), label + ': ' + await control.getAttribute('id') + ' reachable by scrolling and focus');
  }
}
async function inspectPause(page, label) {
  assert.equal(await page.locator(':focus').getAttribute('id'), 'btn-cancel-quit', label + ': initial Resume focus');
  const checkPinned = async () => {
    const metrics = await page.evaluate(() => {
    const dialog = document.querySelector('.quit-confirm-dialog').getBoundingClientRect();
    const resume = document.getElementById('btn-cancel-quit').getBoundingClientRect();
      return { top: dialog.top, bottom: dialog.bottom, resumeTop: resume.top, resumeBottom: resume.bottom, height: innerHeight };
    });
    assert.ok(metrics.top >= 15 && metrics.bottom <= metrics.height - 15 &&
      metrics.resumeTop >= metrics.top && metrics.resumeBottom <= metrics.bottom,
      label + ': viewport margins and Resume fully visible ' + JSON.stringify(metrics));
  };
  await checkPinned();
  const fonts = await page.evaluate(() => ({
    root: parseFloat(getComputedStyle(document.documentElement).fontSize),
    text: parseFloat(getComputedStyle(document.getElementById('paused-speech-mode-hint')).fontSize),
    resume: parseFloat(getComputedStyle(document.getElementById('btn-cancel-quit')).fontSize),
  }));
  assert.ok(fonts.text >= fonts.root * 0.875 && fonts.resume >= fonts.root, label + ': existing readable text sizes preserved');
  const backgroundY = await page.evaluate(() => scrollY);
  const height = await page.evaluate(() => innerHeight);
  await page.mouse.move(8, height / 2);
  for (const delta of [-600, 600]) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => scrollY), backgroundY, label + ': backdrop wheel must not scroll game');
  }
  for (const key of ['PageDown', 'PageUp', 'End', 'Home']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => scrollY), backgroundY, label + ': ' + key + ' must not scroll game');
  }
  const snapshot = await page.getByRole('alertdialog', { name: 'プレイを停止しました' }).ariaSnapshot();
  assert.ok(snapshot.indexOf('button "再開"') >= 0 &&
    snapshot.indexOf('button "再開"') < snapshot.indexOf('combobox "読み上げ方式"'), label + ': accessible reading order starts with Resume');
  await page.locator('.quit-confirm-content').evaluate(el => el.scrollTop = 0);
  const scrollerBox = await page.locator('.quit-confirm-content').boundingBox();
  await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2);
  // Wheel deltas use screen pixels; include enough distance at real browser zoom.
  await page.mouse.wheel(0, await page.locator('.quit-confirm-content').evaluate(el => el.scrollHeight * 8 + 1000));
  await page.waitForTimeout(150);
  const endMetrics = await page.locator('.quit-confirm-content').evaluate(el => ({
    height: el.clientHeight, total: el.scrollHeight, top: el.scrollTop,
    target: document.elementFromPoint(el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2,
      el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2)?.tagName,
  }));
  assert.ok(Math.abs(endMetrics.total - endMetrics.height - endMetrics.top) < 2,
    label + ': modal wheel reaches its final item ' + JSON.stringify(endMetrics));
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => scrollY), backgroundY, label + ': wheel at modal end must not scroll game');
  await checkPinned();
  const controls = await page.locator('#quit-confirm-overlay button, #quit-confirm-overlay select').evaluateAll(elements =>
    elements.filter(el => el.getClientRects().length && !el.disabled).map(el => el.id));
  assert.equal(controls[0], 'btn-cancel-quit');
  assert.ok(controls.includes('btn-quit-top') && controls.includes('btn-quit-hard'));
  for (const id of controls.slice(1)) {
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('id'), id, label + ': keyboard order');
    assert.ok(await page.locator('#' + id).evaluate(el => {
      const rect = el.getBoundingClientRect();
      const scroller = document.querySelector('.quit-confirm-content').getBoundingClientRect();
      return rect.top < scroller.bottom && rect.bottom > scroller.top;
    }), label + ': focused control scrolls into view');
    await checkPinned();
  }
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'), controls[0], label + ': forward focus trap');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'), controls.at(-1), label + ': backward focus trap');
  for (const id of controls.slice(0, -1).reverse()) {
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator(':focus').getAttribute('id'), id, label + ': reverse keyboard order');
  }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator(':focus').getAttribute('id'), controls.at(-1), label + ': reverse wrap after full traversal');
  await page.keyboard.press('Tab');
}
async function inspectPlay(page, label) {
  await inspect(page, label);
  assert.equal(await page.locator('.game-header .subtitle').isVisible(), false, label + ': decorative subtitle hidden only in play');
  for (const selector of ['#score-p1', '#score-p2', '#current-server', '#game-canvas']) {
    assert.ok(await page.locator(selector).isVisible(), label + ': ' + selector + ' remains visible');
  }
}
async function captureChrome(page, filename, fullPage = false) {
  const session = await page.context().newCDPSession(page);
  const options = { format: 'png', captureBeyondViewport: fullPage };
  if (fullPage) {
    await page.evaluate(() => scrollTo(0, 0));
    const { contentSize } = await session.send('Page.getLayoutMetrics');
    options.clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
  }
  const { data } = await session.send('Page.captureScreenshot', options);
  fs.writeFileSync(path.join(artifactDir, filename), Buffer.from(data, 'base64'));
  await session.detach();
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.STT_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ hasTouch: true });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  const url = 'http://127.0.0.1:' + server.address().port;
  let cases = 0, zoomCases = 0;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.gameEngine);
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await page.selectOption('#select-speech-mode', 'screen-reader');
    await page.click('#btn-enable-audio');
    await page.click('#btn-mode-cpu');
    await page.click('#btn-diff-normal');
    await page.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); });
    if (!process.env.STT_LAYOUT_TOUCH_ONLY) {
    if (!process.env.STT_LAYOUT_ZOOM_ONLY) {
    for (const [width, height] of viewports) for (const size of sizes) for (const palette of palettes) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => gameEngine.changeScreen('welcome'));
      await page.selectOption('#select-text-size', size);
      await page.selectOption('#select-contrast', palette);
      const label = `${width}x${height}/${size}/${palette}`;
      await inspect(page, label + '/welcome');
      await inspectWelcome(page, label + '/welcome');
      for (const screen of ['menu', 'difficulty', 'lobby', 'waiting', 'help', 'play']) {
        await page.evaluate(screen => gameEngine.changeScreen(screen), screen);
        await inspect(page, label + '/' + screen);
      }
      await page.evaluate(() => { gameEngine.showQuitConfirmation(); });
      await inspect(page, label + '/pause');
      await inspectPause(page, label + '/pause');
      if (size === 'largest' && palette === 'default') {
        await page.locator('.quit-confirm-content').evaluate(el => el.scrollTop = 0);
        await page.screenshot({ path: path.join(artifactDir, `pause-${width}-largest.png`) });
      }
      await page.locator('#btn-cancel-quit').click();
      await page.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); gameEngine.finishMatch(1); });
      await inspect(page, label + '/result');
      if (palette === 'default' && [1440, 390, 320].includes(width)) {
        await page.evaluate(() => gameEngine.changeScreen('welcome'));
        await page.screenshot({ path: path.join(artifactDir, `welcome-${width}-${size}.png`), fullPage: true });
      }
      cases++;
      if (cases % 16 === 0) console.log('Layout combinations passed: ' + cases);
    }
    await page.evaluate(() => gameEngine.changeScreen('welcome'));
    await page.reload();
    await page.waitForFunction(() => window.gameEngine);
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    assert.equal(await page.locator('#select-text-size').inputValue(), 'largest');
    assert.equal(await page.locator('#select-contrast').inputValue(), 'yellow-on-black');
    assert.equal(await page.locator('#select-speech-mode').inputValue(), 'screen-reader');
    await page.getByRole('combobox', { name: '配色・コントラスト' }).focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('#select-contrast').inputValue(), 'black-on-white');
    await inspect(page, 'native keyboard select');
    }
    // Browser zoom reflow equivalents: 1280x720 at 200% and 400%.
    for (const [width, height] of [[640, 360], [320, 180]]) {
      await page.setViewportSize({ width, height });
      for (const size of sizes) for (const palette of palettes) {
        await page.evaluate(() => gameEngine.changeScreen('welcome'));
        await page.selectOption('#select-text-size', size);
        await page.selectOption('#select-contrast', palette);
        for (const screen of ['welcome', 'menu', 'difficulty', 'play', 'help']) {
          await page.evaluate(screen => gameEngine.changeScreen(screen), screen);
          await inspect(page, `zoom-equivalent ${width}/${size}/${palette}/${screen}`);
        }
        await page.evaluate(() => { gameEngine.changeScreen('play'); gameEngine.showQuitConfirmation(); });
        await inspect(page, 'zoom-equivalent/pause');
        await inspectPause(page, `zoom-equivalent ${width}x${height}/${size}/${palette}/pause`);
        await page.locator('#btn-cancel-quit').click();
        await page.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); });
        zoomCases++;
      }
    }
    }
    // Chrome's real default browser zoom, independent of the app's text setting.
    // A fresh profile avoids changing the user's own browser preferences.
    for (const zoom of [1, 1.25, 1.5, 2]) {
      const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stt-chrome-zoom-'));
      fs.mkdirSync(path.join(profile, 'Default'));
      // Chromium stores default zoom in a dictionary; "x" is the default partition.
      // https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc
      fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } } }));
      const context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.STT_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        headless: true, viewport: null, args: ['--window-size=1440,900'],
      });
      try {
        const zoomPage = context.pages()[0];
        await zoomPage.goto(url);
        await zoomPage.waitForFunction(() => window.gameEngine);
        await zoomPage.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
        const ratio = await zoomPage.evaluate(() => devicePixelRatio);
        assert.ok(Math.abs(ratio - zoom) < 0.02, `Chrome actual zoom ${zoom}: devicePixelRatio=${ratio}`);
        console.log(`Chrome actual zoom ${zoom * 100}% confirmed (devicePixelRatio=${ratio})`);
        for (const size of ['standard', 'largest']) {
          await zoomPage.evaluate(() => gameEngine.changeScreen('welcome'));
          await zoomPage.selectOption('#select-text-size', size);
          await zoomPage.selectOption('#select-speech-mode', 'screen-reader');
          await inspect(zoomPage, `Chrome zoom ${zoom}/${size}`);
          await inspectWelcome(zoomPage, `Chrome zoom ${zoom}/${size}`);
          // Playwright's fullPage dimensions use CSS pixels, which crop captures
          // at real browser zoom. CDP's contentSize uses device-independent pixels.
          await captureChrome(zoomPage, `chrome-zoom-${zoom * 100}-${size}.png`, true);
          await zoomPage.click('#btn-enable-audio');
          await zoomPage.click('#btn-mode-cpu');
          await zoomPage.click('#btn-diff-normal');
          await zoomPage.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); });
          await inspectPlay(zoomPage, `Chrome zoom ${zoom}/${size}/play`);
          await captureChrome(zoomPage, `chrome-zoom-${zoom * 100}-${size}-play.png`, true);
          await zoomPage.evaluate(() => gameEngine.showQuitConfirmation());
          await inspectPause(zoomPage, `Chrome zoom ${zoom}/${size}/pause`);
          await captureChrome(zoomPage, `chrome-zoom-${zoom * 100}-${size}-pause-secondary.png`);
          await zoomPage.locator('.quit-confirm-content').evaluate(el => el.scrollTop = 0);
          await captureChrome(zoomPage, `chrome-zoom-${zoom * 100}-${size}-pause.png`);
          await zoomPage.keyboard.press('Enter');
          assert.equal(await zoomPage.evaluate(() => gameEngine.isGameplayPaused), false, 'Enter resumes immediately');
          assert.ok(await zoomPage.evaluate(() => !document.activeElement.closest('#quit-confirm-overlay') &&
            getComputedStyle(document.documentElement).overflowY !== 'hidden'), 'Resume releases modal focus and document scroll lock');
          await zoomPage.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); });
          await zoomPage.evaluate(() => gameEngine.showQuitConfirmation());
          await zoomPage.keyboard.press('Escape');
          assert.equal(await zoomPage.evaluate(() => gameEngine.isGameplayPaused), false, 'Escape resumes gameplay');
          assert.ok(await zoomPage.evaluate(() => !document.activeElement.closest('#quit-confirm-overlay') &&
            getComputedStyle(document.documentElement).overflowY !== 'hidden'), 'Escape releases modal focus and document scroll lock');
          await zoomPage.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); });
          await zoomPage.evaluate(() => gameEngine.showQuitConfirmation());
          await zoomPage.click('#btn-paused-help');
          assert.ok(await zoomPage.locator('#screen-help').isVisible(), 'pause help opens');
          assert.notEqual(await zoomPage.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'hidden', 'help remains scrollable');
          await zoomPage.keyboard.press('Escape');
          assert.equal(await zoomPage.locator(':focus').getAttribute('id'), 'btn-paused-help', 'help returns focus to its pause button');
          const confirmation = zoomPage.waitForEvent('dialog');
          const topClick = zoomPage.click('#btn-quit-top');
          const confirmDialog = await confirmation;
          assert.equal(confirmDialog.type(), 'confirm', 'TOP keeps its existing confirmation');
          await confirmDialog.accept();
          await topClick;
          assert.equal(await zoomPage.evaluate(() => gameEngine.isGameplayPaused), false, 'TOP exits pause');
          assert.ok(await zoomPage.locator('#screen-menu').isVisible(), 'TOP reaches menu');
          await zoomPage.click('#btn-mode-cpu');
          await zoomPage.click('#btn-diff-normal');
          for (const difficulty of ['easy', 'normal', 'hard']) {
            await zoomPage.evaluate(() => gameEngine.showQuitConfirmation());
            await zoomPage.click('#btn-quit-' + difficulty);
            assert.equal(await zoomPage.evaluate(() => gameEngine.difficulty), difficulty, 'each pause difficulty change works');
            assert.equal(await zoomPage.evaluate(() => gameEngine.isGameplayPaused), false, 'difficulty change exits pause');
            assert.notEqual(await zoomPage.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'hidden', 'difficulty change releases scroll lock');
            await zoomPage.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); });
          }
        }
      } finally { await context.close(); }
    }
    // Real touch scrolling on the game screen must cancel a tap, not hit a ball.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForFunction(() => window.gameEngine);
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await page.selectOption('#select-text-size', 'largest');
    await page.selectOption('#select-contrast', 'default');
    await page.selectOption('#select-speech-mode', 'screen-reader');
    await page.click('#btn-enable-audio');
    await page.click('#btn-mode-cpu');
    await page.click('#btn-diff-normal');
    await page.evaluate(() => {
      gameEngine.changeScreen('play');
      gameEngine.stopLoop(); gameEngine.clearGameplayTasks();
      gameEngine.state = 'RALLY';
      gameEngine.updateActionButton();
      window.layoutActions = 0;
      gameEngine.handleActionInput = () => window.layoutActions++;
      window.scrollTo(0, document.getElementById('screen-play').offsetTop);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const startY = await page.evaluate(() => scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 500 }] });
    for (let y = 480; y >= 200; y -= 20) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    console.log('Touch scroll', await page.evaluate(start => ({ start, end: scrollY, max: document.documentElement.scrollHeight - innerHeight, touchAction: getComputedStyle(document.getElementById('screen-play')).touchAction, target: document.elementFromPoint(195, 300)?.outerHTML.slice(0, 120), actions: layoutActions }), startY));
    assert.ok(await page.evaluate(start => scrollY > start + 50, startY), 'game screen scrolls with touch');
    assert.equal(await page.evaluate(() => layoutActions), 0, 'scroll does not trigger game action');
    await page.evaluate(() => gameEngine.showQuitConfirmation());
    await inspectPause(page, 'mobile 390px/200%');
    const modalBackgroundY = await page.evaluate(() => scrollY);
    const swipe = async (x, start, end) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
      for (let i = 1; i <= 15; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * i / 15 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(200);
    };
    await swipe(5, 650, 300);
    assert.equal(await page.evaluate(() => scrollY), modalBackgroundY, 'mobile backdrop swipe does not scroll game');
    await page.locator('.quit-confirm-content').evaluate(el => el.scrollTop = 0);
    const modalBox = await page.locator('.quit-confirm-content').boundingBox();
    await swipe(modalBox.x + modalBox.width / 2, modalBox.y + modalBox.height - 20, modalBox.y + 20);
    assert.ok(await page.locator('.quit-confirm-content').evaluate(el => el.scrollTop > 40), 'mobile modal content scrolls by touch');
    assert.equal(await page.evaluate(() => scrollY), modalBackgroundY, 'mobile modal swipe keeps game stationary');
    await captureChrome(page, 'mobile-200-modal-touch.png');
    await page.click('#btn-cancel-quit');
    assert.equal(await page.evaluate(() => gameEngine.isGameplayPaused), false, 'mouse/touch-compatible Resume button resumes');
    await page.evaluate(() => { gameEngine.stopLoop(); gameEngine.clearGameplayTasks(); });
    await page.mouse.move(5, 500);
    const resumedY = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(start => scrollY < start, resumedY), 'game document scrolling works again after Resume');
    console.log('Passed pause background wheel/keyboard/touch lock, internal end scrolling, both Tab directions, all difficulty buttons, Enter/Escape/click Resume and restored document scrolling.');
    for (const screen of ['play', 'welcome']) {
      await page.evaluate(screen => gameEngine.changeScreen(screen), screen);
      await page.screenshot({ path: path.join(artifactDir, `${screen}-390-largest-final.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(cases
      ? `Passed ${cases} size/palette/viewport combinations across 9 screens, ${zoomCases} zoom-equivalent combinations, native keyboard selection, settings restoration, touch scrolling without a game action. Screenshots: ${artifactDir}`
      : `Passed real Chrome 100/125/150/200% zoom, accessible settings and touch scrolling without a game action. Screenshots: ${artifactDir}`);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
