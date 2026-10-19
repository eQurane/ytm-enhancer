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

  globalThis[KEY] = Object.freeze({
    snapshot, dataOf, setData, bindRating, ratingOf, playerRating,
    saveToPlaylist, responseOf, isVideoId, isStatus,
  });
})();
