import { DEFAULT_SETTINGS, getSettings, normalizeSettings, setEnabled,
  setDefaultPlaylist, setPlaylistModifier } from './settings.js';

// Shared by the toolbar popup and the options page.
export async function mountSettings() {
  const toggle = document.querySelector('#enabled');
  const status = document.querySelector('#status');
  const playlist = document.querySelector('#default-playlist');
  const modifier = document.querySelector('#playlist-modifier');
  const refresh = document.querySelector('#refresh-playlists');
  const hint = document.querySelector('#playlist-status');
  const actionHint = document.querySelector('#action-hint');
  let saved = { ...DEFAULT_SETTINGS };
  let choices = [];
  const changedKeys = new Set();

  const render = () => {
    toggle.checked = saved.enabled;
    modifier.value = saved.playlistModifier;
    playlist.replaceChildren(new Option('Не выбран', ''));
    const items = [...choices];
    if (saved.defaultPlaylist && !items.some((item) => item.id === saved.defaultPlaylist.id)) {
      items.unshift(saved.defaultPlaylist);
    }
    for (const item of items) playlist.append(new Option(item.title, item.id));
    playlist.value = saved.defaultPlaylist?.id ?? '';
    const key = { shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt' }[saved.playlistModifier];
    actionHint.textContent = `Клик — добавить или убрать из плейлиста по умолчанию. ${key} + клик — выбрать другой плейлист.`;
    status.textContent = saved.enabled ? 'Состояние: включено' : 'Состояние: выключено';
  };

  const manifest = chrome.runtime.getManifest();
  document.querySelector('#version').textContent = manifest.version_name ?? manifest.version;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!changes[key]) continue;
      changedKeys.add(key);
      saved[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key];
    }
    saved = normalizeSettings(saved);
    render();
  });
  try {
    const initial = await getSettings();
    for (const key of Object.keys(DEFAULT_SETTINGS)) if (!changedKeys.has(key)) saved[key] = initial[key];
    render();
    toggle.disabled = modifier.disabled = playlist.disabled = false;
  } catch (error) {
    status.textContent = 'Не удалось загрузить настройки. Откройте окно заново.';
    console.error(error);
    return;
  }

  async function persist(control, change) {
    control.disabled = true;
    try {
      await change();
      // Storage events can arrive before or after the write's promise resolves.
      const current = await getSettings();
      saved = current;
      render();
    } catch (error) {
      render();
      status.textContent = 'Не удалось сохранить настройку. Попробуйте ещё раз.';
      console.error(error);
    } finally {
      control.disabled = false;
    }
  }
  toggle.addEventListener('change', () => {
    const value = toggle.checked;
    persist(toggle, () => setEnabled(value));
  });
  modifier.addEventListener('change', () => {
    const value = modifier.value;
    persist(modifier, () => setPlaylistModifier(value));
  });
  playlist.addEventListener('change', () => {
    const value = choices.find((item) => item.id === playlist.value)
      ?? (playlist.value === saved.defaultPlaylist?.id ? saved.defaultPlaylist : null);
    persist(playlist, () => setDefaultPlaylist(value));
  });

  async function loadPlaylists() {
    refresh.disabled = true;
    hint.textContent = 'Загрузка плейлистов…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Откройте YouTube Music и нажмите иконку расширения на его вкладке.');
      let response;
      try { response = await chrome.tabs.sendMessage(tab.id, { type: 'ytmq:list-playlists' }); }
      catch { throw new Error('Для загрузки списка откройте YouTube Music и нажмите иконку расширения. После обновления расширения перезагрузите вкладку музыки.'); }
      if (response?.error) throw new Error(response.error);
      if (!Array.isArray(response?.playlists)) throw new Error('Не удалось загрузить плейлисты.');
      const codec = globalThis[Symbol.for('ytmq.preferences.v1')];
      choices = response.playlists.map(codec.playlist).filter(Boolean);
      render();
      hint.textContent = !choices.length ? 'Нет доступных для редактирования плейлистов.'
        : saved.defaultPlaylist && !choices.some((item) => item.id === saved.defaultPlaylist.id)
          ? 'Сохранённый плейлист недоступен. Выберите другой.' : 'Выберите плейлист для обычного клика.';
    } catch (error) {
      hint.textContent = error.message;
    } finally { refresh.disabled = false; }
  }
  refresh.addEventListener('click', loadPlaylists);
  await loadPlaylists();
}
