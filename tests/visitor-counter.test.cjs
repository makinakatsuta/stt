const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../docs/js/visitor-counter.js'), 'utf8');
const key = 'sttVisitorNumber';
const attemptKey = 'sttVisitorHitAttempted';
const storage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name),
  };
};
const blocked = { getItem() { throw new Error('blocked'); } };

async function run(options = {}) {
  const nodes = Object.fromEntries(['visitor-counter', 'visitor-number', 'total-visitor-count', 'visitor-counter-status', 'visitor-number-row', 'total-visitor-row'].map(id => [id, { hidden: true, textContent: '---' }]));
  const calls = [];
  const warnings = [];
  let timeoutCleared = false;
  const delays = [];
  const local = options.local ?? storage();
  const session = options.session ?? storage();
  const window = { location: { hostname: options.host ?? 'soundtabletennis.com', protocol: options.protocol ?? 'https:', port: options.port ?? '' }, sessionStorage: session };
  Object.defineProperty(window, 'localStorage', { get() { if (options.blockGetter) throw new Error('blocked'); return local; } });
  const context = vm.createContext({
    window, document: { getElementById: id => nodes[id] }, AbortController,
    setTimeout: (callback, ms) => {
      if (ms === 10000) { if (options.timeout) queueMicrotask(callback); }
      else { delays.push(ms); queueMicrotask(callback); }
      return 1;
    },
    clearTimeout: () => { timeoutCleared = true; },
    console: { warn: (...args) => warnings.push(args) },
    fetch: async (url, init) => {
      calls.push(url);
      if (url.includes('/hit/')) {
        const readAttempt = store => { try { return store.getItem(attemptKey); } catch { return null; } };
        assert.equal(readAttempt(local) === '1' || readAttempt(session) === '1', true);
      }
      assert.equal(init.cache, 'no-store');
      assert.equal(init.credentials, 'omit');
      if (options.timeout) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout'))));
      if (options.error || (options.failFirst && calls.length === 1)) throw new Error('network/CORS');
      return { ok: options.ok ?? true, status: 503, json: async () => {
        if (options.badJSON) throw new SyntaxError('JSON');
        return options.data ?? { value: 1234 };
      } };
    },
  });
  // Suppress auto-start only in this isolated test context.
  vm.runInContext(source.replace('void initializeVisitorCounter();', ''), context);
  if (options.concurrent) await vm.runInContext('Promise.all([initializeVisitorCounter(), initializeVisitorCounter()])', context);
  else await vm.runInContext('initializeVisitorCounter()', context);
  return { calls, nodes, warnings, local, session, timeoutCleared, delays };
}

(async () => {
  const local = storage();
  let result = await run({ local });
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0], /\/hit\//);
  assert.equal(local.getItem(key), '1234');
  assert.equal(result.nodes['visitor-number'].textContent, '1,234');
  assert.equal(result.nodes['visitor-counter'].hidden, false);
  result = await run({ local, data: { value: 1334 } });
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0], /\/get\//);
  assert.equal(result.nodes['visitor-number'].textContent, '1,234');
  assert.equal(result.nodes['total-visitor-count'].textContent, '1,334');
  for (const host of ['localhost', '127.0.0.1', '', 'dev.example.com']) {
    assert.equal((await run({ host })).calls.length, 0);
  }
  assert.equal((await run({ port: '8080' })).calls.length, 0);
  assert.equal((await run({ protocol: 'file:' })).calls.length, 0);
  assert.equal((await run({ host: 'www.soundtabletennis.com' })).calls.length, 1);
  assert.equal((await run({ host: 'makinakatsuta.github.io' })).calls.length, 1);
  for (const value of [1234, '1234', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    const visitorStorage = storage();
    result = await run({ local: visitorStorage, data: { value } });
    assert.match(result.calls[0], /\/hit\//);
    assert.equal(result.nodes['visitor-counter'].hidden, false);
    assert.equal(result.nodes['visitor-number'].textContent, Number(value).toLocaleString('ja-JP'));
    assert.equal(result.nodes['total-visitor-count'].textContent, Number(value).toLocaleString('ja-JP'));
    assert.equal(visitorStorage.getItem(key), String(value));
    assert.equal(result.warnings.length, 0);
    result = await run({ local: visitorStorage, data: { value: String(value) } });
    assert.equal(result.calls.length, 1);
    assert.match(result.calls[0], /\/get\//);
    assert.equal(result.nodes['visitor-counter'].hidden, false);
    assert.equal(result.nodes['visitor-number'].textContent, Number(value).toLocaleString('ja-JP'));
  }
  result = await run({ local: storage({ [key]: '1234' }), data: { value: '1567' } });
  assert.equal(result.nodes['visitor-number'].textContent, '1,234');
  assert.equal(result.nodes['total-visitor-count'].textContent, '1,567');
  const session = storage();
  result = await run({ blockGetter: true, session });
  assert.equal(session.getItem(key), '1234');
  result = await run({ local: blocked, session });
  assert.match(result.calls[0], /\/get\//);
  result = await run({ local: blocked, session: blocked });
  assert.match(result.calls[0], /\/get\//);
  assert.equal(result.nodes['visitor-counter'].hidden, false);
  assert.equal(result.nodes['visitor-number-row'].hidden, true);
  assert.match(result.nodes['visitor-counter-status'].textContent, /総訪問者数のみ/);
  const full = { getItem: () => null, setItem() { throw new Error('full'); } };
  assert.equal((await run({ local: full })).session.getItem(key), '1234');
  // A fallback number must survive even if localStorage becomes usable again.
  result = await run({ local: storage(), session: storage({ [key]: '4321' }), data: { value: 4567 } });
  assert.match(result.calls[0], /\/get\//);
  assert.equal(result.nodes['visitor-number'].textContent, '4,321');
  assert.equal(result.nodes['total-visitor-count'].textContent, '4,567');
  // Existing numbers remain usable even when further writes are blocked.
  result = await run({ local: { getItem: () => '1234', setItem() { throw new Error('read-only'); } } });
  assert.match(result.calls[0], /\/get\//);
  let writes = 0;
  const changingValues = storage();
  const changingStorage = {
    getItem: changingValues.getItem,
    setItem(name, value) {
      if (name === key && ++writes > 1) throw new Error('storage changed during request');
      changingValues.setItem(name, value);
    },
    removeItem: changingValues.removeItem,
  };
  result = await run({ local: changingStorage });
  assert.equal(result.session.getItem(key), '1234');
  assert.equal(result.nodes['visitor-counter'].hidden, false);
  // Failure while reading totals must neither discard the number nor retry hit.
  const returningLocal = storage({ [key]: '1234' });
  result = await run({ local: returningLocal, error: true });
  assert.equal(result.calls.length, 3);
  assert.match(result.calls[0], /\/get\//);
  assert.equal(returningLocal.getItem(key), '1234');
  assert.equal(result.nodes['visitor-counter'].hidden, false);
  assert.match(result.nodes['visitor-counter-status'].textContent, /取得できませんでした/);
  for (const saved of ['0', '-1', '1.5', 'NaN', 'Infinity', '', '9007199254740992']) {
    assert.match((await run({ local: storage({ [key]: saved }) })).calls[0], /\/hit\//);
  }
  const invalidValues = [
    0, '0', -1, '-1', 1.2, '1.2', 'abc', null, undefined,
    Infinity, -Infinity, NaN, 'Infinity', 9007199254740992, '9007199254740992',
    '', ' 1234 ', '01', '+1', '1e3', true, false, [], {},
  ];
  for (const data of [{}, ...invalidValues.map(value => ({ value }))]) {
    result = await run({ data });
    assert.equal(result.nodes['visitor-counter'].hidden, false);
    assert.equal(result.nodes['total-visitor-row'].hidden, true);
    assert.equal(result.local.getItem(key), null);
    assert.equal(result.local.getItem(attemptKey), '1');
    assert.equal(result.calls.filter(url => url.includes('/hit/')).length, 1);
    assert.equal(result.warnings.length, 1);
  }
  for (const options of [{ error: true }, { ok: false }, { badJSON: true }, { timeout: true }]) {
    result = await run(options);
    assert.equal(result.nodes['visitor-counter'].hidden, false);
    assert.match(result.nodes['visitor-counter-status'].textContent, /再読み込み/);
    assert.deepEqual(result.delays, [1500, 4000]);
    assert.equal(result.calls.length, 3);
    assert.equal(result.calls.filter(url => url.includes('/hit/')).length, 1);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.timeoutCleared, true);
  }
  // The first hit may have succeeded remotely: GET recovery must not invent a number.
  const uncertain = storage();
  result = await run({ local: uncertain, failFirst: true });
  assert.deepEqual(result.calls.map(url => url.includes('/hit/') ? 'hit' : 'get'), ['hit', 'get']);
  assert.equal(result.nodes['total-visitor-row'].hidden, false);
  assert.equal(result.nodes['visitor-number-row'].hidden, true);
  assert.equal(uncertain.getItem(key), null);
  const uncertainSession = result.session;
  result = await run({ blockGetter: true, session: uncertainSession });
  assert.match(result.calls[0], /\/get\//);
  result = await run({ local: uncertain });
  assert.match(result.calls[0], /\/get\//);
  assert.equal(result.nodes['visitor-number-row'].hidden, true);
  result = await run({ local: storage({ [key]: '42' }), failFirst: true });
  assert.ok(result.calls.every(url => url.includes('/get/')));
  assert.equal(result.nodes['visitor-number'].textContent, '42');
  assert.equal(result.nodes['visitor-counter-status'].hidden, true);
  result = await run({ concurrent: true });
  assert.equal(result.calls.length, 1);
  // A pending session attempt survives localStorage becoming available again.
  result = await run({ local: storage(), session: storage({ [attemptKey]: '1' }) });
  assert.match(result.calls[0], /\/get\//);
  const deniedMarker = { getItem: () => null, removeItem() {}, setItem(name) { if (name === attemptKey) throw Error('denied'); } };
  assert.match((await run({ local: deniedMarker })).calls[0], /\/get\//);
  const vanishedValues = storage();
  const vanished = { getItem: vanishedValues.getItem, removeItem: vanishedValues.removeItem, setItem(name, value) {
    if (name === key && ++vanished.writes > 1) throw Error('gone');
    vanishedValues.setItem(name, value);
  }, writes: 0 };
  result = await run({ local: vanished, session: blocked });
  assert.equal(result.nodes['visitor-number'].textContent, '1,234');
  assert.equal(result.nodes['visitor-counter-status'].hidden, true);
  for (const value of [1, 123, 1234, 12345]) {
    assert.equal((await run({ data: { value } })).nodes['visitor-number'].textContent, value.toLocaleString('ja-JP'));
  }
  const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
  const region = html.match(/<section id="visitor-counter"[\s\S]*?<\/section>/)[0];
  assert.match(region, /hidden/);
  assert.doesNotMatch(region, /aria-live|role=|tabindex/);
  assert.doesNotMatch(source, /sr-announcer|\.focus\(|addEventListener/);
  assert.match(html, /type="module" src="js\/visitor-counter.js\?v=3.31.49"/);
  // A failed counter request must not block the independent game bootstrap
  // or its existing keyboard activation handlers.
  const handlers = {};
  let starts = 0;
  const button = { addEventListener: (name, callback) => { handlers[name] = callback; }, click: () => starts++ };
  const gameContext = vm.createContext({
    window: {}, document: { readyState: 'complete', getElementById: () => button },
    GameEngine: class {}, console,
  });
  const app = fs.readFileSync(path.join(__dirname, '../docs/app.js'), 'utf8').replace(/^import .*;$/m, '');
  vm.runInContext(app, gameContext);
  assert.ok(gameContext.window.gameEngine);
  for (const key of ['Enter', ' ']) {
    let prevented = false;
    handlers.keydown({ key, repeat: false, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.equal(starts, 2);
  console.log('Visitor counter checks passed: first visit, reload, totals, hosts, storage fallback, validation, failures, timeout, formatting and passive markup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
