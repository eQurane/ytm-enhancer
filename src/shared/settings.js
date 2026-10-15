export const DEFAULT_SETTINGS = Object.freeze({ enabled: true });

export function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

export function setEnabled(enabled) {
  return chrome.storage.local.set({ enabled: Boolean(enabled) });
}
