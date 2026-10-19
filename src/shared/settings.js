import './preferences.js';

const preferences = globalThis[Symbol.for('ytmq.preferences.v1')];
export const DEFAULT_SETTINGS = preferences.defaults;
export const normalizeSettings = preferences.normalize;

export function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS).then(normalizeSettings);
}

export function setEnabled(enabled) {
  return chrome.storage.local.set({ enabled: Boolean(enabled) });
}

export function setDefaultPlaylist(playlist) {
  return chrome.storage.local.set({ defaultPlaylist: preferences.playlist(playlist) });
}

export function setPlaylistModifier(playlistModifier) {
  return chrome.storage.local.set({ playlistModifier: normalizeSettings({ playlistModifier }).playlistModifier });
}
