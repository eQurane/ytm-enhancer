import { DEFAULT_SETTINGS, getSettings, setEnabled } from './settings.js';

// Shared by the popup and the options page.
export async function mountSettings() {
  const toggle = document.querySelector('#enabled');
  const status = document.querySelector('#status');
  let savedEnabled = DEFAULT_SETTINGS.enabled;

  const render = (enabled) => {
    savedEnabled = enabled;
    toggle.checked = enabled;
    status.textContent = enabled ? 'Состояние: включено' : 'Состояние: выключено';
  };

  document.querySelector('#version').textContent = chrome.runtime.getManifest().version;

  try {
    const settings = await getSettings();
    render(settings.enabled);
    toggle.disabled = false;
  } catch (error) {
    status.textContent = 'Не удалось загрузить настройки. Откройте окно заново.';
    console.error(error);
    return;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {
      render(changes.enabled.newValue ?? DEFAULT_SETTINGS.enabled);
    }
  });

  toggle.addEventListener('change', async () => {
    const nextEnabled = toggle.checked;
    toggle.disabled = true;
    try {
      await setEnabled(nextEnabled);
      render(nextEnabled);
    } catch (error) {
      toggle.checked = savedEnabled;
      status.textContent = 'Не удалось сохранить настройку. Попробуйте ещё раз.';
      console.error(error);
    } finally {
      toggle.disabled = false;
    }
  });
}
