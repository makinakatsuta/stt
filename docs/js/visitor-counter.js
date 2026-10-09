const API_BASE = 'https://countapi.mileshilliard.com/api/v1';
const COUNTER_KEY = 'soundtabletennis-com-total-visitors';
const STORAGE_KEY = 'sttVisitorNumber';
const ATTEMPT_KEY = 'sttVisitorHitAttempted';
const TIMEOUT_MS = 10000;
const RETRY_DELAYS_MS = [1500, 4000];
const ALLOWED_HOSTS = [
  'soundtabletennis.com',
  'www.soundtabletennis.com',
  'makinakatsuta.github.io',
];

function parseCounterValue(value) {
  if (
    typeof value !== 'number' &&
    !(typeof value === 'string' && /^[1-9]\d*$/.test(value))
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function readVisitorNumber(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function findStorage() {
  let writable = null;
  let existing = null;
  let attempted = false;
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[name];
      const saved = storage.getItem(STORAGE_KEY);
      const number = readVisitorNumber(saved);
      if (number !== null) existing ??= { storage, number };
      attempted ||= storage.getItem(ATTEMPT_KEY) === '1';
      // Test writes using only the visitor-number key, before calling hit.
      storage.setItem(STORAGE_KEY, saved ?? '');
      if (saved === null) storage.removeItem(STORAGE_KEY);
      writable ??= { storage, number: null };
    } catch {
      // Storage may be blocked or full; try sessionStorage next.
    }
  }
  return { ...(existing ?? writable), attempted };
}

function saveVisitorNumber(storage, number) {
  try {
    storage.setItem(STORAGE_KEY, String(number));
  } catch {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, String(number));
    } catch {
      // A successful response is still displayed if storage becomes unavailable.
    }
  }
}

async function fetchCount(action) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}/${action}/${COUNTER_KEY}`, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`Counter HTTP ${response.status}`);
    const data = await response.json();
    const count = parseCounterValue(data?.value);
    if (count === null) {
      throw new Error('Invalid counter value');
    }
    return count;
  } finally {
    clearTimeout(timeout);
  }
}

let counterInitialization;
function initializeVisitorCounter() {
  // Multiple callers in the same page share one request sequence.
  return counterInitialization ??= loadVisitorCounter();
}

async function loadVisitorCounter() {
    if (!ALLOWED_HOSTS.includes(window.location.hostname)) return;
    if (!['https:', 'http:'].includes(window.location.protocol) || window.location.port) return;
    const region = document.getElementById('visitor-counter');
    const visitor = document.getElementById('visitor-number');
    const total = document.getElementById('total-visitor-count');
    const status = document.getElementById('visitor-counter-status');
    const visitorRow = document.getElementById('visitor-number-row');
    const totalRow = document.getElementById('total-visitor-row');
    if (!region || !visitor || !total || !status || !visitorRow || !totalRow) return;
    region.hidden = false;
    status.hidden = false;
    status.textContent = '訪問者数を取得しています。';
    const stored = findStorage();
    let number = stored.number ?? null;
    let action = 'get';
    if (number === null && stored.storage && !stored.attempted) {
      try {
        // Persist BEFORE hit: an aborted/failed response may already have counted.
        stored.storage.setItem(ATTEMPT_KEY, '1');
        // Keep a session fallback if localStorage becomes blocked on a reload.
        for (const name of ['localStorage', 'sessionStorage']) {
          try {
            const storage = window[name];
            if (storage !== stored.storage) storage.setItem(ATTEMPT_KEY, '1');
          } catch {
            // The selected storage already holds the required attempt record.
          }
        }
        action = 'hit';
      } catch {
        // No durable attempt record: read only, never risk a duplicate increment.
      }
    }
    if (number !== null) {
      visitor.textContent = number.toLocaleString('ja-JP');
      visitorRow.hidden = false;
    }
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
      }
      try {
        // Only the first request can hit. Every recovery request is read-only.
        const count = await fetchCount(attempt === 0 ? action : 'get');
        if (attempt === 0 && action === 'hit') {
          number = count;
          saveVisitorNumber(stored.storage, number);
          visitor.textContent = number.toLocaleString('ja-JP');
          visitorRow.hidden = false;
        }
        total.textContent = count.toLocaleString('ja-JP');
        totalRow.hidden = false;
        status.hidden = number !== null;
        status.textContent = number === null ? '訪問者番号は確認できません。総訪問者数のみ表示します。' : '';
        return;
      } catch (error) {
        status.textContent = attempt < RETRY_DELAYS_MS.length
          ? '訪問者数を取得できませんでした。しばらくして再取得します。'
          : '訪問者数を取得できませんでした。ページを再読み込みすると再取得できます。';
        if (attempt === RETRY_DELAYS_MS.length) {
          console.warn('訪問者情報を取得できませんでした。', error);
        }
      }
    }
}

// Independent of game bootstrap; never announce, focus, or intercept input.
void initializeVisitorCounter();
