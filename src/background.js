import { DEFAULT_SETTINGS } from './shared/settings.js';

// Register event listeners at module scope so the browser can wake the worker.
chrome.runtime.onInstalled.addListener(() => {
  initializeSettings().catch((error) => {
    console.error('Не удалось инициализировать настройки:', error);
  });
});

async function initializeSettings() {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => current[key] === undefined),
  );

  // Preserve existing preferences when the extension is updated.
  if (Object.keys(missing).length > 0) {
    await chrome.storage.local.set(missing);
  }
}
