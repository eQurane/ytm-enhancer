(() => {
  'use strict';

  const preferences = globalThis[Symbol.for('ytmq.preferences.v1')];
  let settings = { ...preferences.defaults };
  const changedKeys = new Set();
  const requests = new Map();
  let sequence = 0;

  function publish() {
    document.documentElement.setAttribute('data-ytmq-settings', JSON.stringify(settings));
    document.documentElement.setAttribute('data-ytmq-enabled', String(settings.enabled));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    for (const key of Object.keys(preferences.defaults)) {
      if (!changes[key]) continue;
      changed = true;
      changedKeys.add(key);
      settings[key] = changes[key].newValue ?? preferences.defaults[key];
    }
    if (!changed) return;
    settings = preferences.normalize(settings);
    publish();
  });
  chrome.storage.local.get(preferences.defaults).then((initial) => {
    // Merge per key: a recent modifier change must not discard the saved playlist.
    for (const key of Object.keys(preferences.defaults)) {
      if (!changedKeys.has(key)) settings[key] = initial[key] ?? preferences.defaults[key];
    }
    settings = preferences.normalize(settings);
    publish();
  }).catch((error) => {
    if (!changedKeys.has('enabled')) settings.enabled = false;
    publish();
    console.error('[YTM Queue] Не удалось прочитать настройки:', error);
  });

  // Only fixed operations and plain metadata cross the isolated/page boundary,
  // never credentials or arbitrary service endpoints.
  function pageRequest() {
    const id = `extension-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error('YouTube Music не ответил. Обновите вкладку музыки.'));
      }, 20000);
      requests.set(id, { resolve, reject, timer });
      document.dispatchEvent(new CustomEvent('ytmq-playlists-request', { detail: JSON.stringify({ id }) }));
    });
  }
  document.addEventListener('ytmq-playlists-response', (event) => {
    try {
      const response = JSON.parse(event.detail);
      const request = requests.get(response.id);
      if (!request) return;
      clearTimeout(request.timer);
      requests.delete(response.id);
      if (response.error) request.reject(new Error(String(response.error).slice(0, 500)));
      else if (Array.isArray(response.playlists)) {
        request.resolve(response.playlists.map(preferences.playlist).filter(Boolean));
      } else request.reject(new Error('Не удалось прочитать список плейлистов.'));
    } catch { /* Ignore malformed page messages. */ }
  });
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id || request?.type !== 'ytmq:list-playlists') return;
    pageRequest().then((playlists) => respond({ playlists }), (error) => respond({ error: error.message }));
    return true;
  });
  document.addEventListener('ytmq-default-playlist-request', (event) => {
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    const playlist = preferences.playlist(request.playlist);
    if (!playlist || typeof request.id !== 'string' || request.id.length > 100) return;
    chrome.storage.local.set({ defaultPlaylist: playlist }).then(() => {
      document.dispatchEvent(new CustomEvent('ytmq-default-playlist-response', {
        detail: JSON.stringify({ id: request.id }),
      }));
    }).catch(() => {
      document.dispatchEvent(new CustomEvent('ytmq-default-playlist-response', {
        detail: JSON.stringify({ id: request.id, error: 'Не удалось сохранить плейлист по умолчанию.' }),
      }));
    });
  });
})();
