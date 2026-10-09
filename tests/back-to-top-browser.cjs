// Native back-to-top activation, focus and responsive-layout regression.
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
    const button = page.getByRole('button', { name: 'トップページに戻る', exact: true });
    const heading = page.getByRole('heading', { name: 'SOUND TABLE TENNIS STT', level: 1 });
    assert.equal(await button.isVisible(), false, 'not on welcome screen');
    await page.selectOption('#select-speech-mode', 'screen-reader');
    await page.locator('#range-speech-rate').fill('1.4');
    await page.click('#btn-enable-audio');
    await page.waitForFunction(() => !document.getElementById('screen-menu').classList.contains('hidden'));
    assert.equal(await button.evaluate(el => el.previousElementSibling.id), 'btn-show-help');
    assert.ok(await button.evaluate(el => !!(el.compareDocumentPosition(document.getElementById('game-footer')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    assert.equal(await button.getAttribute('type'), 'button');
    assert.equal(await heading.getAttribute('tabindex'), '-1');
    const ax = await page.context().newCDPSession(page);
    const artifactDir = process.env.STT_TOP_ARTIFACTS || path.join(require('node:os').tmpdir(), 'stt-back-to-top');
    fs.mkdirSync(artifactDir, { recursive: true });
    async function scrollToButton() {
      await button.evaluate(el => {
        el.scrollIntoView({block:'end',behavior:'instant'});
        el.focus({preventScroll:true});
        const maxScroll = document.documentElement.scrollHeight - innerHeight;
        window.scrollTo({top:Math.max(scrollY, Math.min(100,maxScroll)),behavior:'instant'});
      });
      assert.ok(await page.evaluate(() => scrollY > 0 || document.documentElement.scrollHeight <= innerHeight), 'scroll first when the page is taller than the viewport');
    }
    async function checkResult() {
      await page.waitForFunction(() => document.activeElement.id === 'page-title' && scrollY === 0);
      await page.waitForTimeout(50);
      assert.deepEqual(await page.evaluate(() => ({x:scrollX,y:scrollY,focus:document.activeElement.id,state:gameEngine.state})), {x:0,y:0,focus:'page-title',state:'MENU'});
      assert.ok(await page.locator('#screen-welcome').isVisible());
      assert.equal(await page.locator('#screen-menu').isVisible(), false);
      assert.equal(await button.isVisible(), false);
      assert.equal(await page.locator('#select-speech-mode').inputValue(), 'screen-reader');
      assert.equal(await page.locator('#range-speech-rate').inputValue(), '1.4');
      assert.equal(await page.evaluate(() => localStorage.getItem('stt_speech_rate')), '1.4');
      const {nodes} = await ax.send('Accessibility.getFullAXTree');
      const title = nodes.find(n => n.role?.value === 'heading' && n.name?.value === 'SOUND TABLE TENNIS STT');
      assert.ok(title.properties.some(p => p.name === 'focused' && p.value.value));
      assert.equal(title.properties.find(p => p.name === 'level').value.value, 1);
    }
    let cases=0;
    for (const [width,height] of [[320,568],[375,667],[390,844],[568,320],[844,390],[1280,720]]) {
      await page.setViewportSize({width,height});
      for (const size of ['standard','large','extra-large','largest']) for (const reducedMotion of ['no-preference','reduce']) {
        await page.emulateMedia({reducedMotion});
        await page.evaluate(() => gameEngine.changeScreen('welcome'));
        await page.selectOption('#select-text-size', size);
        await page.evaluate(() => gameEngine.changeScreen('menu'));
        // Ensure CSS smooth-scroll cannot override the requested instant action.
        await page.addStyleTag({content:'html { scroll-behavior: smooth; }'});
        const metrics = await button.evaluate(el => {
          const r=el.getBoundingClientRect(); const range=document.createRange();range.selectNodeContents(el);
          return {height:r.height,width:r.width,overflow:document.documentElement.scrollWidth>innerWidth,
            textInside:[...range.getClientRects()].every(t=>t.left>=r.left&&t.right<=r.right+1&&t.top>=r.top&&t.bottom<=r.bottom+1),
            transition:getComputedStyle(el).transitionDuration};
        });
        assert.ok(metrics.height>=44 && metrics.width>=44 && metrics.textInside && !metrics.overflow);
        assert.equal(metrics.transition,'0s');
        assert.match(await button.ariaSnapshot(), /button "トップページに戻る"/);
        for (const method of ['click','Enter','Space','tap','AT-click']) {
          await page.evaluate(() => gameEngine.changeScreen('menu'));
          await scrollToButton();
          if (method==='click') await button.click();
          else if (method==='tap') await button.tap();
          else if (method==='AT-click') await button.dispatchEvent('click',{detail:0});
          else await button.press(method);
          await checkResult();
        }
        // The heading stays out of sequential keyboard navigation.
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'select-contrast');
        if (width===320 && reducedMotion==='reduce' && ['standard','largest'].includes(size)) {
          await page.evaluate(() => gameEngine.changeScreen('menu'));
          await button.scrollIntoViewIfNeeded();
          await page.screenshot({path:path.join(artifactDir,'menu-320-'+size+'.png'),fullPage:true});
        }
        cases++;
      }
    }
    // Remove the deliberately injected smooth-scroll style before checking
    // unrelated screen transitions and stop any in-flight focus scrolling.
    await page.addStyleTag({content:'html {scroll-behavior:auto!important;} *,*::before,*::after {animation:none!important;transition:none!important;}'});
    // Hidden controls must not scroll or steal focus from other screens.
    for (const screen of ['welcome','difficulty','help','play']) {
      await page.evaluate(screen => gameEngine.changeScreen(screen),screen);
      assert.equal(await button.isVisible(),false);
      await page.evaluate(() => window.scrollTo({top:scrollY,behavior:'instant'}));
      const before=await page.evaluate(() => ({y:scrollY,focus:document.activeElement.id,state:gameEngine.state}));
      await page.locator('#btn-back-to-top').dispatchEvent('click',{detail:0});
      assert.deepEqual(await page.evaluate(() => ({y:scrollY,focus:document.activeElement.id,state:gameEngine.state})),before);
    }
    console.log('Passed ' + cases + ' return-to-welcome layouts, settings preserved, instant scrolling, native heading focus/accessibility, click/Enter/Space/touch/AT-click, Tab order and other-screen isolation. Screenshots: ' + artifactDir);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode=1; });
