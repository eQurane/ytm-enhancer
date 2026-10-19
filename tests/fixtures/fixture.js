// A local mock of the site's native custom elements and command executor.
// It deliberately does not share a rating store: the extension must synchronize
// duplicate rows and the player itself. No production APIs or credentials here.
(() => {
  let signedIn = true;
  let failNext = false;
  let requests = 0;
  let plays = 0;
  globalThis.ytcfg = { get: () => signedIn };
  const titles = new Map();
  const playlists = new Map([
    ['PL_fixture_music', { title: 'music', videos: new Set(['aaaaaaaaaaa', 'bbbbbbbbbbb']) }],
    ['PL_fixture_later', { title: 'listen later', videos: new Set(['ccccccccccc']) }],
  ]);
  let preferences = { enabled: true, defaultPlaylist: null, playlistModifier: 'shift' };
  function publish() {
    document.documentElement.setAttribute('data-ytmq-settings', JSON.stringify(preferences));
    document.documentElement.setAttribute('data-ytmq-enabled', String(preferences.enabled));
  }
  document.addEventListener('ytmq-default-playlist-request', (event) => {
    const request = JSON.parse(event.detail);
    preferences.defaultPlaylist = request.playlist;
    document.querySelector('#playlist').value = request.playlist.id;
    publish();
    document.dispatchEvent(new CustomEvent('ytmq-default-playlist-response', { detail: JSON.stringify({ id: request.id }) }));
  });
  function summary() {
    document.querySelector('#requests').textContent = `Запросов: ${requests} · Запусков песни: ${plays}`;
  }
  // Browse is a navigation command in the real site. Only its network manager
  // can read a playlist without changing the current page.
  document.querySelector('ytmusic-app').networkManager = {
    getRequestParams: (params) => params,
    fetch(path, params) { return this.sendRequest_(path, params); },
    sendRequest_(path, params) {
      if (path !== '/browse') throw new Error('Unexpected fixture path');
      requests += 1;
      summary();
      const shouldFail = failNext;
      failNext = false;
      return new Promise((resolve, reject) => setTimeout(() => {
        if (shouldFail) { reject(new Error('Тестовая ошибка сети. Повторите действие.')); return; }
        const playlist = playlists.get(params.browseId?.slice(2));
        if (!playlist) { resolve({ error: { code: 404 } }); return; }
        resolve({ contents: { musicPlaylistShelfRenderer: {
          contents: [...playlist.videos].map((videoId) => ({ musicResponsiveListItemRenderer: {
            playlistItemData: { videoId, playlistSetVideoId: `set_${videoId}` },
          } })),
        } } });
      }, 100));
    },
  };

  class LikeRenderer extends HTMLElement {
    set data(data) {
      this.value = data;
      this.render();
    }
    get data() { return this.value; }
    connectedCallback() { this.render(); }
    render() {
      if (!this.value) return;
      this.setAttribute('like-status', this.value.likeStatus);
      this.replaceChildren();
      for (const [status, label, path] of [
        ['LIKE', 'Like', 'M2 10h4v12H2V10Zm6 12V10l5-8 2 1v5h5l2 2-3 12H8Z'],
        ['DISLIKE', 'Dislike', 'M2 2h4v12H2V2Zm6 0h11l3 12-2 2h-5v5l-2 1-5-8V2Z'],
      ]) {
        const item = document.createElement('button');
        item.setAttribute('aria-label', label);
        item.setAttribute('aria-pressed', String(this.value.likeStatus === status));
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shape.setAttribute('d', path);
        svg.append(shape);
        item.append(svg);
        item.addEventListener('click', () => {
          const next = this.value.likeStatus === status ? 'INDIFFERENT' : status;
          const endpoint = this.value.serviceEndpoints.find((entry) => entry.likeEndpoint.status === next);
          // The real component may optimistically paint its own button. Tests
          // must prove a rejected request restores the previous confirmed state.
          this.data = { ...this.value, likeStatus: next };
          const detail = { actionName: 'yt-service-request', args: [this, endpoint], returnValue: [] };
          this.dispatchEvent(new CustomEvent('yt-action', { bubbles: true, detail }));
        });
        this.append(item);
      }
    }
  }
  customElements.define('ytmusic-like-button-renderer', LikeRenderer);

  function data(videoId, title, artist, likeStatus = 'INDIFFERENT', isPlayable = true) {
    titles.set(videoId, title);
    return { videoId, title, artist, isPlayable, menu: { menuRenderer: {
      topLevelButtons: [{ likeButtonRenderer: {
        target: { videoId }, likeStatus, likesAllowed: true,
        serviceEndpoints: ['LIKE', 'DISLIKE', 'INDIFFERENT'].map((status) => ({
          likeEndpoint: { target: { videoId }, status },
        })),
      } }],
      items: [{ menuNavigationItemRenderer: { text: { simpleText: 'Save to playlist' },
        navigationEndpoint: { addToPlaylistEndpoint: { videoId } } } }],
    } } };
  }

  const queue = document.querySelector('ytmusic-player-queue');
  for (const entry of [
    data('aaaaaaaaaaa', 'TNT', 'CORTIS', 'LIKE'),
    data('bbbbbbbbbbb', 'GO AHEAD', 'YOUNG POSSE'),
    data('ccccccccccc', 'A very long song title that should be truncated safely', 'A very long artist name', 'DISLIKE'),
    data('aaaaaaaaaaa', 'TNT', 'CORTIS', 'LIKE'),
    data('ddddddddddd', 'Недоступная песня', 'Artist', 'INDIFFERENT', false),
  ]) {
    const row = document.createElement('ytmusic-player-queue-item');
    row.data = entry;
    const cover = document.createElement('div');
    cover.className = 'left-items';
    cover.textContent = '♫';
    const info = document.createElement('div');
    info.className = 'song-info';
    const title = document.createElement('span');
    title.className = 'song-title';
    title.textContent = entry.title;
    const artist = document.createElement('span');
    artist.className = 'byline';
    artist.textContent = entry.artist;
    info.append(title, artist);
    const menu = document.createElement('ytmusic-menu-renderer');
    menu.textContent = '⋮';
    menu.className = 'menu';
    const duration = document.createElement('span');
    duration.className = 'duration';
    duration.textContent = '2:30';
    row.append(cover, info, menu, duration);
    row.addEventListener('click', () => { plays += 1; summary(); });
    queue.append(row);
  }
  const player = document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer');
  player.data = data('bbbbbbbbbbb', 'GO AHEAD', 'YOUNG POSSE').menu.menuRenderer.topLevelButtons[0].likeButtonRenderer;

  document.addEventListener('yt-action', (event) => {
    const { actionName, args, returnValue } = event.detail;
    if (actionName === 'yt-service-request') {
      if (args[1].browseEndpoint || args[1].continuationCommand) return;
      requests += 1;
      summary();
      const shouldFail = failNext;
      failNext = false;
      document.querySelector('#fail').textContent = 'Ошибка следующего запроса';
      returnValue.push({ ajaxPromise: new Promise((resolve, reject) => {
        setTimeout(() => {
          if (shouldFail) reject(new Error('Тестовая ошибка сети. Повторите действие.'));
          else if (args[1].addToPlaylistEndpoint) {
            const videoId = args[1].addToPlaylistEndpoint.videoIds?.[0];
            resolve({ data: { contents: [{ addToPlaylistRenderer: {
              playlists: [...playlists].map(([id, playlist]) => ({ playlistAddToOptionRenderer: {
                playlistId: id, title: { simpleText: playlist.title },
                // Deliberately omit containsSelectedVideos like the current
                // music UI. Historical membership must come from browse data.
                addToPlaylistServiceEndpoint: { playlistEditEndpoint: {
                  playlistId: id, actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
                } },
              } })),
            } }] } });
          } else if (args[1].browseEndpoint) {
            const id = args[1].browseEndpoint.browseId.slice(2);
            const playlist = playlists.get(id);
            if (!playlist) { resolve({ data: { error: { code: 404 } } }); return; }
            resolve({ data: { contents: { musicPlaylistShelfRenderer: {
              contents: [...playlist.videos].map((videoId) => ({ musicResponsiveListItemRenderer: {
                playlistItemData: { videoId, playlistSetVideoId: `set_${videoId}` },
              } })),
            } } } });
          } else if (args[1].playlistEditEndpoint) {
            const edit = args[1].playlistEditEndpoint;
            const playlist = playlists.get(edit.playlistId);
            if (!playlist) { resolve({ data: { error: { code: 404 } } }); return; }
            for (const item of edit.actions) {
              if (item.action === 'ACTION_ADD_VIDEO') playlist.videos.add(item.addedVideoId);
              else playlist.videos.delete(item.removedVideoId);
            }
            resolve({ data: { success: true } });
          } else resolve({ data: { success: true } });
        }, 100);
      }) });
    } else if (actionName === 'yt-open-popup-action') {
      const videoId = args[0].openPopupAction.popup.addToPlaylistRenderer.videoId;
      const dialog = document.createElement('dialog');
      const title = document.createElement('h2');
      title.textContent = `Save to playlist: ${titles.get(videoId)}`;
      const close = document.createElement('button');
      close.textContent = 'Закрыть';
      close.onclick = () => { dialog.close(); dialog.remove(); };
      dialog.append(title, close);
      document.body.append(dialog);
      dialog.showModal();
    }
  });

  document.querySelector('#toggle').onclick = (event) => {
    const enabled = preferences.enabled = !preferences.enabled;
    publish();
    event.target.textContent = enabled ? 'Выключить' : 'Включить';
  };
  document.querySelector('#narrow').onclick = () => document.querySelector('#panel').classList.toggle('narrow');
  document.querySelector('#replace').onclick = () => {
    // No DOM mutation: the click guard must detect the changed identity itself.
    queue.firstElementChild.data = data('eeeeeeeeeee', 'Replacement song', 'New artist');
  };
  document.querySelector('#reorder').onclick = () => queue.prepend(queue.lastElementChild);
  document.querySelector('#fail').onclick = (event) => {
    failNext = true;
    event.target.textContent = 'Следующий запрос завершится ошибкой';
  };
  document.querySelector('#guest').onclick = (event) => {
    signedIn = !signedIn;
    event.target.textContent = signedIn ? 'Выйти из аккаунта' : 'Войти в аккаунт';
  };
  document.querySelector('#playlist').onchange = (event) => {
    const id = event.target.value;
    preferences.defaultPlaylist = id ? { id, title: playlists.get(id)?.title ?? 'music' } : null;
    publish();
  };
  document.querySelector('#modifier').onchange = (event) => {
    preferences.playlistModifier = event.target.value;
    publish();
  };
  document.querySelector('#delete-playlist').onclick = () => {
    playlists.delete('PL_fixture_music');
  };
  publish();
})();
