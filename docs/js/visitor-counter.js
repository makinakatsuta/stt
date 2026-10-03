const API_BASE = 'https://countapi.mileshilliard.com/api/v1';
const COUNTER_KEY = 'soundtabletennis-com-total-visitors';
const STORAGE_KEY = 'sttVisitorNumber';
const TIMEOUT_MS = 4000;
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
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[name];
      const saved = storage.getItem(STORAGE_KEY);
      const number = readVisitorNumber(saved);
      if (number !== null) return { storage, number };
      // Test writes using only the visitor-number key, before calling hit.
      storage.setItem(STORAGE_KEY, saved ?? '');
      if (saved === null) storage.removeItem(STORAGE_KEY);
      writable ??= { storage, number: null };
    } catch {
      // Storage may be blocked or full; try sessionStorage next.
    }
  }
  return writable;
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

async function initializeVisitorCounter() {
  try {
    if (!ALLOWED_HOSTS.includes(window.location.hostname)) return;
    if (!['https:', 'http:'].includes(window.location.protocol) || window.location.port) return;
    const region = document.getElementById('visitor-counter');
    const visitor = document.getElementById('visitor-number');
    const total = document.getElementById('total-visitor-count');
    if (!region || !visitor || !total) return;
    const stored = findStorage();
    // Without persistent storage, a reload would count the same browser again.
    if (!stored) return;
    const count = await fetchCount(stored.number === null ? 'hit' : 'get');
    const number = stored.number ?? count;
    if (stored.number === null) {
      try {
        stored.storage.setItem(STORAGE_KEY, String(number));
      } catch (error) {
        // Storage availability can change while the request is in flight.
        window.sessionStorage.setItem(STORAGE_KEY, String(number));
      }
    }
    visitor.textContent = number.toLocaleString('ja-JP');
    total.textContent = count.toLocaleString('ja-JP');
    region.hidden = false;
  } catch (error) {
    console.warn('訪問者情報を取得できませんでした。', error);
  }
}

// Independent of game bootstrap; never announce, focus, or intercept input.
void initializeVisitorCounter();
