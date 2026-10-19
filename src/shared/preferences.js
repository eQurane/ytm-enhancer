(() => {
  'use strict';
  const key = Symbol.for('ytmq.preferences.v1');
  if (globalThis[key]) return;
  const defaults = Object.freeze({ enabled: true, defaultPlaylist: null, playlistModifier: 'shift' });
  const isPlaylistId = (id) => typeof id === 'string' && /^[\w-]{2,160}$/.test(id);
  function playlist(value) {
    return value && isPlaylistId(value.id) && typeof value.title === 'string'
      && value.title.trim().length > 0 && value.title.length <= 500
      ? { id: value.id, title: value.title } : null;
  }
  function normalize(value = {}) {
    return {
      enabled: value.enabled === undefined ? defaults.enabled : value.enabled === true,
      defaultPlaylist: playlist(value.defaultPlaylist),
      playlistModifier: ['shift', 'ctrl', 'alt'].includes(value.playlistModifier)
        ? value.playlistModifier : defaults.playlistModifier,
    };
  }
  globalThis[key] = Object.freeze({ defaults, playlist, normalize, isPlaylistId });
})();
