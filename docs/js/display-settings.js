// Restore display preferences before the page is painted, independently of audio.
(() => {
  const settings = [
    { id: 'select-contrast', key: 'stt_contrast', attribute: 'contrast', values: ['default', 'white-on-black', 'black-on-white', 'yellow-on-black'], fallback: 'default' },
    { id: 'select-text-size', key: 'stt_text_size', attribute: 'textSize', values: ['standard', 'large', 'extra-large', 'largest'], fallback: 'standard' },
  ];

  for (const setting of settings) {
    let value = setting.fallback;
    try {
      const saved = localStorage.getItem(setting.key);
      if (setting.values.includes(saved)) value = saved;
    } catch {
      // Preferences still work for this visit when storage is unavailable.
    }
    document.documentElement.dataset[setting.attribute] = value;
  }

  document.addEventListener('DOMContentLoaded', () => {
    for (const setting of settings) {
      const select = document.getElementById(setting.id);
      if (!select) continue;
      select.value = document.documentElement.dataset[setting.attribute];
      select.addEventListener('change', () => {
        if (!setting.values.includes(select.value)) return;
        document.documentElement.dataset[setting.attribute] = select.value;
        try {
          localStorage.setItem(setting.key, select.value);
        } catch {
          // Applying the setting does not depend on saving it.
        }
      });
    }
  }, { once: true });
})();
