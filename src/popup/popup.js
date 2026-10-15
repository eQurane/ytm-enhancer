import { mountSettings } from '../shared/settings-ui.js';

mountSettings();

document.querySelector('#open-settings').addEventListener('click', async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    document.querySelector('#status').textContent = 'Не удалось открыть настройки.';
    console.error(error);
  }
});
