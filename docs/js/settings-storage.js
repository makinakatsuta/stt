// Keep settings usable for this session even when browser storage is blocked.
const sessionSettings = new Map();

export function readSetting(key) {
  if (sessionSettings.has(key)) return sessionSettings.get(key);
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key, value) {
  const text = String(value);
  sessionSettings.set(key, text);
  try {
    localStorage.setItem(key, text);
  } catch {
    // The current session still uses the selected value.
  }
}
