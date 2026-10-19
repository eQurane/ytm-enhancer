(() => {
  'use strict';

  const KEY = Symbol.for('ytmq.adapter.v1');
  if (globalThis[KEY]) return;
  const STATUSES = ['LIKE', 'DISLIKE', 'INDIFFERENT'];
  const isVideoId = (value) => typeof value === 'string' && /^[\w-]{11}$/.test(value);
  const isStatus = (value) => STATUSES.includes(value);
  const dataOf = (element) => element?.data ?? element?.rawProps?.data
    ?? element?.polymerController?.data ?? element?.__data?.data;

  function unwrap(data) {
    return data?.playlistPanelVideoRenderer
      ?? data?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer
      ?? data;
  }

  function textOf(text) {
    return text?.simpleText ?? text?.runs?.map((run) => run.text ?? '').join('') ?? '';
  }

  function loggedOut() {
    const config = globalThis.ytcfg;
    return (typeof config?.get === 'function' ? config.get('LOGGED_IN')
      : config?.data_?.LOGGED_IN) === false;
  }

  function accountKey() {
    const config = globalThis.ytcfg;
    const get = (key) => typeof config?.get === 'function' ? config.get(key) : config?.data_?.[key];
    // Used only in memory to discard state after an account switch.
    return `${get('LOGGED_IN')}:${get('SESSION_INDEX')}:${get('DELEGATED_SESSION_ID')}`;
  }

  function targetsVideo(endpoint, videoId) {
    const target = endpoint?.addToPlaylistEndpoint;
    return target?.videoId === videoId
      || (target?.videoIds?.length === 1 && target.videoIds[0] === videoId);
  }

  function snapshot(row) {
    const source = unwrap(dataOf(row));
    const videoId = source?.videoId ?? source?.navigationEndpoint?.watchEndpoint?.videoId;
    if (!isVideoId(videoId)) return null;
    const menu = source.menu?.menuRenderer ?? dataOf(row.querySelector('ytmusic-menu-renderer'));
    const items = menu?.items ?? [];
    const nativeLike = menu?.topLevelButtons?.map((button) => button.likeButtonRenderer)
      .find((like) => like?.target?.videoId === videoId);
    const toggle = items.map((item) => item.toggleMenuServiceItemRenderer)
      .find((item) => item?.defaultServiceEndpoint?.likeEndpoint?.target?.videoId === videoId);
    const navigationItem = items.map((item) => item.menuNavigationItemRenderer
      ?? item.menuServiceItemRenderer)
      .find((item) => targetsVideo(item?.navigationEndpoint ?? item?.serviceEndpoint, videoId));
    const toggleStatus = toggle?.defaultServiceEndpoint?.likeEndpoint?.status;
    // Queue menus may only distinguish LIKE from "not liked". Do not claim that
    // an absent dislike flag is a confirmed INDIFFERENT rating.
    const status = isStatus(nativeLike?.likeStatus) ? nativeLike.likeStatus
      : isStatus(source.likeStatus) ? source.likeStatus
        : toggleStatus === 'INDIFFERENT' ? 'LIKE' : null;
    const playable = source.isPlayable !== false && !row.hasAttribute('unplayable');
    const canRate = playable && !loggedOut() && nativeLike?.likesAllowed !== false
      && Boolean(nativeLike || toggle);
    const likeData = nativeLike ? { ...nativeLike } : {
      target: { videoId },
      // The native component also consults YouTube Music's in-memory rating store.
      likeStatus: status ?? 'INDIFFERENT',
      trackingParams: source.trackingParams,
      serviceEndpoints: STATUSES.map((rating) => ({
        likeEndpoint: { status: rating, target: { videoId } },
      })),
    };
    likeData.likesAllowed = canRate;
    return {
      source, videoId, status, likeData, canRate,
      canSave: playable && !loggedOut() && Boolean(navigationItem),
      playlistEndpoint: navigationItem?.navigationEndpoint ?? navigationItem?.serviceEndpoint,
      saveLabel: textOf(navigationItem?.text) || 'Добавить в плейлист',
    };
  }

  function setData(element, data) {
    // YouTube Music currently mixes newer custom elements and Polymer elements.
    if (typeof element.setters?.data === 'function') element.setters.data(data);
    else if (typeof element.set === 'function') element.set('data', data);
    else element.data = data;
  }

  function bindRating(renderer, entry, status = entry.status) {
    const data = { ...entry.likeData, likeStatus: status ?? entry.likeData.likeStatus };
    setData(renderer, data);
    return data;
  }

  function ratingOf(renderer) {
    const status = renderer?.getAttribute('like-status') ?? renderer?.likeStatus
      ?? dataOf(renderer)?.likeStatus;
    return isStatus(status) ? status : null;
  }

  function playerRating() {
    const renderer = document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer');
    const videoId = dataOf(renderer)?.target?.videoId;
    return isVideoId(videoId) ? { renderer, videoId, status: ratingOf(renderer) } : null;
  }

  function action(origin, actionName, args) {
    const detail = { actionName, args, optionalAction: false, returnValue: [] };
    origin.dispatchEvent(new CustomEvent('yt-action', {
      bubbles: true, composed: true, detail,
    }));
    return detail.returnValue;
  }

  function withTimeout(promise, milliseconds = 15000) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('YouTube Music не подтвердил действие.')), milliseconds);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async function responseOf(returnValue) {
    const promise = returnValue?.find((value) => value?.ajaxPromise)?.ajaxPromise;
    if (!promise || typeof promise.then !== 'function') {
      throw new Error('Штатное действие YouTube Music недоступно. Обновите страницу.');
    }
    const response = await withTimeout(promise);
    if (!response || response.error || response.data?.error
      || response.data?.alerts?.some((item) => item.alertRenderer?.type === 'ERROR')
      || response.ok === false || (typeof response.status === 'number' && response.status >= 400)) {
      throw new Error('YouTube Music отклонил действие. Попробуйте ещё раз.');
    }
    return response.data ?? response;
  }

  async function saveToPlaylist(origin, entry) {
    if (!entry.canSave || !targetsVideo(entry.playlistEndpoint, entry.videoId)) {
      throw new Error('Добавление этой песни в плейлист недоступно.');
    }
    const data = await responseOf(action(origin, 'yt-service-request', [origin, entry.playlistEndpoint]));
    // Only open a dialog when the response supplies its renderer. The native
    // command executor can instead save to the remembered playlist and handle
    // its own confirmation; a successful request does not require a dialog.
    const renderer = data.contents?.map((item) => item.addToPlaylistRenderer).find(Boolean);
    if (renderer) {
      const anchor = origin.isConnected ? origin : document.querySelector('ytmusic-app');
      if (!anchor) throw new Error('Страница YouTube Music была закрыта.');
      action(anchor, 'yt-open-popup-action', [{
        openPopupAction: { popup: { addToPlaylistRenderer: renderer }, popupType: 'DIALOG' },
      }, anchor]);
    }
  }

  const isPlaylistId = (value) => typeof value === 'string' && /^[\w-]{2,160}$/.test(value);

  function nodes(data, key, found = []) {
    if (!data || typeof data !== 'object') return found;
    if (data[key]) found.push(data[key]);
    for (const [name, value] of Object.entries(data)) {
      if (name !== key && value && typeof value === 'object') nodes(value, key, found);
    }
    return found;
  }

  function validEdit(endpoint, playlistId, videoId, operation) {
    const edit = endpoint?.playlistEditEndpoint;
    return edit?.playlistId === playlistId && Array.isArray(edit.actions) && edit.actions.length > 0
      && edit.actions.every((item) => operation === 'add'
        ? item.action === 'ACTION_ADD_VIDEO' && item.addedVideoId === videoId
        : item.action === 'ACTION_REMOVE_VIDEO' && typeof item.setVideoId === 'string'
          && item.setVideoId !== 'to_be_updated_by_client'
          && (!item.removedVideoId || item.removedVideoId === videoId));
  }

  async function listPlaylists(origin, videoId) {
    if (loggedOut()) throw new Error('Войдите в аккаунт YouTube Music.');
    if (videoId !== undefined && !isVideoId(videoId)) throw new Error('Не удалось определить песню.');
    // Construct a read-only request. Never reuse params from the queue's save
    // command: they can instruct the server to save to the remembered playlist.
    const endpoint = { addToPlaylistEndpoint: { videoIds: videoId ? [videoId] : [] } };
    const data = await responseOf(action(origin, 'yt-service-request', [origin, endpoint]));
    const renderer = nodes(data, 'addToPlaylistRenderer')[0];
    if (!renderer || !Array.isArray(renderer.playlists)) {
      throw new Error('YouTube Music не вернул список плейлистов. Обновите страницу.');
    }
    const result = new Map();
    for (const item of renderer.playlists) {
      const option = item.playlistAddToOptionRenderer;
      const addEndpoint = option?.addToPlaylistServiceEndpoint;
      const id = option?.playlistId ?? addEndpoint?.playlistEditEndpoint?.playlistId;
      const title = textOf(option?.title).slice(0, 500);
      const edit = addEndpoint?.playlistEditEndpoint;
      if (!isPlaylistId(id) || !title || option.isEditable === false || edit?.playlistId !== id
        || !Array.isArray(edit.actions) || !edit.actions.length
        || !edit.actions.every((entry) => entry.action === 'ACTION_ADD_VIDEO'
          && (!videoId || entry.addedVideoId === videoId))) continue;
      const removeEndpoint = option.removeFromPlaylistServiceEndpoint;
      result.set(id, {
        id, title,
        contains: option.containsSelectedVideos === 'ALL' ? true
          : option.containsSelectedVideos === 'NONE' ? false : null,
        addEndpoint: videoId && validEdit(addEndpoint, id, videoId, 'add') ? addEndpoint : null,
        removeEndpoint: videoId && validEdit(removeEndpoint, id, videoId, 'remove') ? removeEndpoint : null,
      });
    }
    return [...result.values()];
  }

  async function readPlaylist(origin, playlistId) {
    if (loggedOut() || !isPlaylistId(playlistId)) throw new Error('Плейлист недоступен. Выберите другой.');
    const videos = new Map();
    const seen = new Set();
    let endpoint = { browseEndpoint: { browseId: `VL${playlistId}` } };
    while (endpoint) {
      const app = document.querySelector('ytmusic-app');
      const manager = [app, app?.polymerController, app?.inst]
        .map((element) => element?.networkManager).find((value) => typeof value?.fetch === 'function');
      // Browse commands are navigation, so yt-service-request can consume them
      // without returning ajaxPromise. Read through the site's own network
      // manager instead; it supplies the current session and never navigates.
      let data;
      if (manager) {
        const params = endpoint.browseEndpoint ?? { continuation: endpoint.continuationCommand.token };
        const request = typeof manager.sendRequest_ === 'function' && typeof manager.getRequestParams === 'function'
          ? manager.sendRequest_('/browse', manager.getRequestParams(params)) : manager.fetch('/browse', params);
        data = await responseOf([{ ajaxPromise: request }]);
      } else {
        data = await responseOf(action(origin, 'yt-service-request', [origin, endpoint]));
      }
      const shelves = [...nodes(data, 'musicPlaylistShelfRenderer'), ...nodes(data, 'musicShelfRenderer'),
        ...nodes(data, 'musicPlaylistShelfContinuation'), ...nodes(data, 'musicShelfContinuation')];
      const appended = nodes(data, 'appendContinuationItemsAction');
      if (!shelves.length && !appended.length) {
        throw new Error('Не удалось проверить содержимое плейлиста. Выберите другой или повторите попытку.');
      }
      const content = [...shelves, ...appended];
      for (const item of nodes(content, 'musicResponsiveListItemRenderer')) {
        const videoId = item.playlistItemData?.videoId;
        const setId = item.playlistItemData?.playlistSetVideoId;
        if (!isVideoId(videoId)) continue;
        const ids = videos.get(videoId) ?? [];
        if (typeof setId === 'string' && !ids.includes(setId)) ids.push(setId);
        videos.set(videoId, ids);
      }
      const token = nodes(content, 'nextContinuationData')[0]?.continuation;
      const command = nodes(content, 'continuationItemRenderer')
        .map((item) => item.continuationEndpoint).find((item) => item?.continuationCommand?.token);
      endpoint = command ?? (token ? { continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } : null);
      const next = endpoint?.continuationCommand?.token;
      if (endpoint && (!next || seen.has(next))) throw new Error('Не удалось дочитать плейлист. Повторите попытку.');
      if (next) seen.add(next);
    }
    return videos;
  }

  async function editPlaylist(origin, videoId, option, add, setIds = []) {
    if (loggedOut() || !isVideoId(videoId) || !isPlaylistId(option?.id)) {
      throw new Error('Изменение плейлиста недоступно.');
    }
    let endpoint = add ? option.addEndpoint : option.removeEndpoint;
    if (!add && !endpoint && setIds.length) {
      endpoint = { playlistEditEndpoint: { playlistId: option.id, actions: setIds.map((setVideoId) => ({
        action: 'ACTION_REMOVE_VIDEO', setVideoId, removedVideoId: videoId,
      })) } };
    }
    if (!validEdit(endpoint, option.id, videoId, add ? 'add' : 'remove')) {
      throw new Error('Команда плейлиста недоступна. Обновите страницу или выберите другой плейлист.');
    }
    await responseOf(action(origin, 'yt-service-request', [origin, endpoint]));
  }

  globalThis[KEY] = Object.freeze({
    snapshot, dataOf, setData, bindRating, ratingOf, playerRating,
    saveToPlaylist, responseOf, isVideoId, isStatus, isPlaylistId, listPlaylists, readPlaylist, editPlaylist, accountKey,
  });
})();
