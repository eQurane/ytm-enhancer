import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/youtube-adapter.js', import.meta.url), 'utf8');
const VIDEO = 'aaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbb';

function setup({ loggedIn = true, player = null, app = null } = {}) {
  const context = vm.createContext({
    setTimeout, clearTimeout,
    ytcfg: { get: () => loggedIn },
    document: { querySelector: (selector) => selector === 'ytmusic-app' ? app : player },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
  });
  vm.runInContext(source, context);
  return vm.runInContext("globalThis[Symbol.for('ytmq.adapter.v1')]", context);
}

function row(data, menu) {
  return { data, querySelector: () => menu && { data: menu }, hasAttribute: () => false };
}

function metadata(videoId = VIDEO, status = 'LIKE') {
  return {
    videoId,
    menu: { menuRenderer: {
      topLevelButtons: [{ likeButtonRenderer: {
        target: { videoId }, likeStatus: status, likesAllowed: true,
        serviceEndpoints: ['LIKE', 'DISLIKE', 'INDIFFERENT'].map((rating) => ({
          likeEndpoint: { status: rating, target: { videoId } },
        })),
      } }],
      items: [{ menuNavigationItemRenderer: {
        text: { runs: [{ text: 'Save to playlist' }] },
        navigationEndpoint: { clickTrackingParams: 'native-tracking', addToPlaylistEndpoint: { videoId } },
      } }],
    } },
  };
}

test('reads a song and preserves its native rating and playlist endpoints', () => {
  const adapter = setup();
  const data = metadata(VIDEO, 'DISLIKE');
  const entry = adapter.snapshot(row(data));
  assert.equal(entry.videoId, VIDEO);
  assert.equal(entry.status, 'DISLIKE');
  assert.equal(entry.canRate, true);
  assert.equal(entry.canSave, true);
  assert.equal(entry.playlistEndpoint, data.menu.menuRenderer.items[0].menuNavigationItemRenderer.navigationEndpoint);
  assert.equal(entry.saveLabel, 'Save to playlist');
});

test('supports wrapper metadata and the menu component data fallback', () => {
  const adapter = setup();
  const data = metadata();
  const wrapped = { playlistPanelVideoWrapperRenderer: {
    primaryRenderer: { playlistPanelVideoRenderer: { videoId: VIDEO } },
  } };
  assert.equal(adapter.snapshot(row(wrapped, data.menu.menuRenderer)).canSave, true);
  assert.equal(adapter.snapshot(row({ playlistPanelVideoRenderer: data })).canRate, true);
});

test('a recycled row resolves the new song on every read', () => {
  const adapter = setup();
  const element = row(metadata(VIDEO));
  assert.equal(adapter.snapshot(element).videoId, VIDEO);
  element.data = metadata(OTHER, 'INDIFFERENT');
  const current = adapter.snapshot(element);
  assert.equal(current.videoId, OTHER);
  assert.equal(current.likeData.target.videoId, OTHER);
  assert.equal(current.playlistEndpoint.addToPlaylistEndpoint.videoId, OTHER);
});

test('does not borrow actions for a different song or a whole playlist', () => {
  const adapter = setup();
  const data = metadata(OTHER);
  data.videoId = VIDEO;
  let entry = adapter.snapshot(row(data));
  assert.equal(entry.canRate, false);
  assert.equal(entry.canSave, false);
  data.menu.menuRenderer.items[0].menuNavigationItemRenderer.navigationEndpoint.addToPlaylistEndpoint = {
    videoIds: [VIDEO, OTHER],
  };
  entry = adapter.snapshot(row(data));
  assert.equal(entry.canSave, false);
});

test('rejects invalid song identifiers and safely handles missing metadata', () => {
  const adapter = setup();
  for (const value of [null, {}, { videoId: '../anything' }, { videoId: 123 }]) {
    assert.equal(adapter.snapshot(row(value)), null);
  }
  const entry = adapter.snapshot(row({ videoId: VIDEO }));
  assert.equal(entry.canRate, false);
  assert.equal(entry.canSave, false);
});

test('signed-out users and unplayable songs have disabled actions', () => {
  const guest = setup({ loggedIn: false }).snapshot(row(metadata()));
  assert.equal(guest.canRate, false);
  assert.equal(guest.canSave, false);
  const data = metadata();
  data.isPlayable = false;
  const unavailable = setup().snapshot(row(data));
  assert.equal(unavailable.canRate, false);
  assert.equal(unavailable.canSave, false);
});

test('fallback rating data targets only the row and preserves unknown historical dislikes', () => {
  const adapter = setup();
  const data = metadata();
  delete data.menu.menuRenderer.topLevelButtons;
  data.menu.menuRenderer.items.push({ toggleMenuServiceItemRenderer: {
    defaultServiceEndpoint: { likeEndpoint: { status: 'LIKE', target: { videoId: VIDEO } } },
  } });
  let entry = adapter.snapshot(row(data));
  assert.equal(entry.status, null);
  assert.equal(entry.canRate, true);
  assert.deepEqual(Array.from(entry.likeData.serviceEndpoints, (endpoint) => endpoint.likeEndpoint.target.videoId),
    [VIDEO, VIDEO, VIDEO]);
  data.menu.menuRenderer.items[1].toggleMenuServiceItemRenderer.defaultServiceEndpoint.likeEndpoint.status = 'INDIFFERENT';
  entry = adapter.snapshot(row(data));
  assert.equal(entry.status, 'LIKE');
});

test('uses each supported native component binding API without mutating source data', () => {
  const adapter = setup();
  const entry = adapter.snapshot(row(metadata()));
  let modernData;
  adapter.bindRating({ setters: { data: (data) => { modernData = data; } } }, entry, 'DISLIKE');
  assert.equal(modernData.likeStatus, 'DISLIKE');
  assert.equal(entry.likeData.likeStatus, 'LIKE');
  let polymerData;
  adapter.bindRating({ set: (key, data) => { assert.equal(key, 'data'); polymerData = data; } }, entry);
  assert.equal(polymerData.target.videoId, VIDEO);
  const plain = {};
  adapter.bindRating(plain, entry);
  assert.equal(plain.data.likeStatus, 'LIKE');
});

test('reads current native rating from DOM state and validates player identity', () => {
  const player = { data: { target: { videoId: OTHER }, likeStatus: 'LIKE' },
    getAttribute: () => 'DISLIKE' };
  const adapter = setup({ player });
  assert.equal(adapter.playerRating().videoId, OTHER);
  assert.equal(adapter.playerRating().status, 'DISLIKE');
  player.data.target.videoId = 'invalid';
  assert.equal(adapter.playerRating(), null);
});

test('waits for native confirmation and rejects absent, failed and rejected requests', async () => {
  const adapter = setup();
  let finish;
  let complete = false;
  const request = adapter.responseOf([{ ajaxPromise: new Promise((resolve) => { finish = resolve; }) }]);
  request.then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false);
  finish({ data: { done: true } });
  assert.equal((await request).done, true);
  await assert.rejects(adapter.responseOf([]), /недоступно/);
  await assert.rejects(adapter.responseOf([{ ajaxPromise: Promise.resolve({ data: { error: {} } }) }]), /отклонил/);
  await assert.rejects(adapter.responseOf([{ ajaxPromise: Promise.resolve({ status: 403 }) }]), /отклонил/);
  await assert.rejects(adapter.responseOf([{ ajaxPromise: Promise.resolve({ data: {
    alerts: [{ alertRenderer: { type: 'ERROR' } }],
  } }) }]), /отклонил/);
  await assert.rejects(adapter.responseOf([{ ajaxPromise: Promise.reject(new Error('offline')) }]), /offline/);
});

test('normalizes native rejected response objects and preserves playlist conflict status', async () => {
  const adapter = setup();
  for (const response of [{ status: 409 }, { data: { error: { code: 409 } } }]) {
    for (const promise of [Promise.resolve(response), Promise.reject(response)]) {
      await assert.rejects(adapter.responseOf([{ ajaxPromise: promise }]), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /Плейлист изменился/);
        return true;
      });
    }
  }
  for (const response of [undefined, { error: { code: 503 } }, 'Failed to fetch']) {
    await assert.rejects(adapter.responseOf([{ ajaxPromise: Promise.reject(response) }]), /YouTube Music/);
  }
});

test('requests the selected song and opens the native playlist dialog', async () => {
  const adapter = setup();
  const entry = adapter.snapshot(row(metadata(OTHER)));
  const events = [];
  const origin = { isConnected: true, dispatchEvent(event) {
    events.push(event);
    if (event.detail.actionName === 'yt-service-request') {
      event.detail.returnValue.push({ ajaxPromise: Promise.resolve({ data: {
        contents: [{ addToPlaylistRenderer: { title: 'Choose playlist' } }],
      } }) });
    }
  } };
  await adapter.saveToPlaylist(origin, entry);
  assert.equal(events[0].detail.args[1].addToPlaylistEndpoint.videoId, OTHER);
  assert.equal(events[1].detail.actionName, 'yt-open-popup-action');
  assert.equal(events[1].detail.args[0].openPopupAction.popupType, 'DIALOG');
  assert.equal(events[1].detail.args[0].openPopupAction.popup.addToPlaylistRenderer.title, 'Choose playlist');
});

test('accepts successful native handling without inventing a playlist dialog', async () => {
  const adapter = setup();
  let popups = 0;
  const origin = { dispatchEvent(event) {
    if (event.detail.actionName === 'yt-open-popup-action') popups += 1;
    else event.detail.returnValue.push({ ajaxPromise: Promise.resolve({ data: {} }) });
  } };
  await adapter.saveToPlaylist(origin, adapter.snapshot(row(metadata())));
  assert.equal(popups, 0);
  const entry = adapter.snapshot(row(metadata()));
  entry.playlistEndpoint = { addToPlaylistEndpoint: { videoId: OTHER } };
  await assert.rejects(adapter.saveToPlaylist(origin, entry), /недоступно/);
});

test('sequential saves accept a remembered playlist without extra dialogs or retries', async () => {
  const adapter = setup();
  const responses = [
    { contents: [{ addToPlaylistRenderer: { title: 'Choose playlist' } }] },
    { actions: [{ addToToastAction: { item: {
      notificationTextRenderer: { successResponseText: { simpleText: 'Added to playlist' } },
    } } }] },
    { onResponseReceivedActions: [{ openPopupAction: { popupType: 'TOAST' } }] },
    {},
  ];
  const requestedVideos = [];
  const popups = [];
  const origin = { isConnected: true, dispatchEvent(event) {
    const { actionName, args, returnValue } = event.detail;
    if (actionName === 'yt-service-request') {
      requestedVideos.push(args[1].addToPlaylistEndpoint.videoId);
      returnValue.push({ ajaxPromise: Promise.resolve({ data: responses.shift() }) });
    } else if (actionName === 'yt-open-popup-action') {
      popups.push(args[0].openPopupAction);
    }
  } };
  for (const videoId of [VIDEO, OTHER, VIDEO, OTHER]) {
    await adapter.saveToPlaylist(origin, adapter.snapshot(row(metadata(videoId))));
  }
  assert.deepEqual(requestedVideos, [VIDEO, OTHER, VIDEO, OTHER]);
  assert.equal(responses.length, 0);
  assert.equal(popups.length, 1);
  assert.equal(popups[0].popupType, 'DIALOG');
});

test('playlist saves still reject network and server errors without opening dialogs', async () => {
  const adapter = setup();
  let popups = 0;
  let nextResponse = () => Promise.reject(new Error('offline'));
  const origin = { dispatchEvent(event) {
    if (event.detail.actionName === 'yt-open-popup-action') popups += 1;
    else event.detail.returnValue.push({ ajaxPromise: nextResponse() });
  } };
  const entry = adapter.snapshot(row(metadata()));
  await assert.rejects(adapter.saveToPlaylist(origin, entry), /offline/);
  nextResponse = () => Promise.resolve({ data: { error: { code: 403 } } });
  await assert.rejects(adapter.saveToPlaylist(origin, entry), /отклонил/);
  assert.equal(popups, 0);
});

function service(respond) {
  const commands = [];
  return { commands, dispatchEvent(event) {
    assert.equal(event.detail.actionName, 'yt-service-request');
    const command = event.detail.args[1];
    commands.push(command);
    event.detail.returnValue.push({ ajaxPromise: Promise.resolve().then(() => ({ data: respond(command) })) });
  } };
}

function playlistOption(videoId = VIDEO, contains = 'NONE') {
  return { playlistAddToOptionRenderer: {
    playlistId: 'PL_music', title: { simpleText: 'Music' }, containsSelectedVideos: contains,
    addToPlaylistServiceEndpoint: { playlistEditEndpoint: { playlistId: 'PL_music',
      actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }] } },
    removeFromPlaylistServiceEndpoint: { playlistEditEndpoint: { playlistId: 'PL_music',
      actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId: 'set-video', removedVideoId: videoId }] } },
  } };
}

test('playlist discovery always constructs a read request and validates editable targets', async () => {
  const adapter = setup();
  const wrongVideo = playlistOption(OTHER);
  const readOnly = playlistOption();
  readOnly.playlistAddToOptionRenderer.isEditable = false;
  const origin = service(() => ({ contents: [{ addToPlaylistRenderer: {
    playlists: [playlistOption(), wrongVideo, readOnly],
  } }] }));
  const options = await adapter.listPlaylists(origin, VIDEO);
  assert.equal(options.length, 1);
  assert.equal(options[0].contains, false);
  assert.deepEqual(JSON.parse(JSON.stringify(origin.commands)), [{ addToPlaylistEndpoint: { videoIds: [VIDEO] } }]);
  assert.equal('params' in origin.commands[0].addToPlaylistEndpoint, false);
  const unknown = playlistOption(VIDEO, undefined);
  delete unknown.playlistAddToOptionRenderer.containsSelectedVideos;
  const missingState = service(() => ({ contents: [{ addToPlaylistRenderer: { playlists: [unknown] } }] }));
  assert.equal((await adapter.listPlaylists(missingState, VIDEO))[0].contains, null);
  await assert.rejects(adapter.listPlaylists(service(() => ({})), VIDEO), /не вернул/);
  await assert.rejects(setup({ loggedIn: false }).listPlaylists(origin, VIDEO), /Войдите/);
});

test('historical membership reads every page and collects removal identifiers', async () => {
  const adapter = setup();
  const origin = service((command) => command.browseEndpoint ? {
    contents: { musicPlaylistShelfRenderer: { contents: [{ musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: VIDEO, playlistSetVideoId: 'first' },
    } }], continuations: [{ nextContinuationData: { continuation: 'page2' } }] } },
  } : { continuationContents: { musicPlaylistShelfContinuation: { contents: [{ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId: OTHER, playlistSetVideoId: 'second' },
  } }] } } });
  const videos = await adapter.readPlaylist(origin, 'PL_music');
  assert.deepEqual([...videos.keys()], [VIDEO, OTHER]);
  assert.deepEqual(Array.from(videos.get(OTHER)), ['second']);
  assert.equal(origin.commands[1].continuationCommand.token, 'page2');
  await assert.rejects(adapter.readPlaylist(service(() => ({})), 'PL_music'), /проверить/);
});

test('playlist reads reject repeated continuations rather than claiming partial absence', async () => {
  const adapter = setup();
  const origin = service(() => ({ contents: { musicPlaylistShelfRenderer: {
    contents: [], continuations: [{ nextContinuationData: { continuation: 'repeat' } }],
  } } }));
  await assert.rejects(adapter.readPlaylist(origin, 'PL_music'), /дочитать/);
  assert.equal(origin.commands.length, 2);
});

test('browse reads use the native network manager without navigating or reusing its response cache', async () => {
  const calls = [];
  const manager = {
    fetch() { throw new Error('cached path must not be used'); },
    getRequestParams(params) { return { ...params, context: { request: { sessionIndex: 'native' } } }; },
    async sendRequest_(path, params) {
      calls.push({ path, params });
      return { contents: { musicPlaylistShelfRenderer: { contents: [] } } };
    },
  };
  const adapter = setup({ app: { polymerController: { networkManager: manager } } });
  const videos = await adapter.readPlaylist({ dispatchEvent() { throw new Error('must not navigate'); } }, 'PL_music');
  assert.equal(videos.size, 0);
  assert.equal(calls[0].path, '/browse');
  assert.equal(calls[0].params.browseId, 'VLPL_music');
  assert.equal(calls[0].params.context.request.sessionIndex, 'native');
});

test('playlist edits use only matching native commands and remove every matching occurrence', async () => {
  const adapter = setup();
  const origin = service(() => ({ success: true }));
  const option = { id: 'PL_music', addEndpoint: playlistOption().playlistAddToOptionRenderer.addToPlaylistServiceEndpoint };
  await adapter.editPlaylist(origin, VIDEO, option, true);
  await adapter.editPlaylist(origin, VIDEO, option, false, ['first', 'second']);
  assert.equal(origin.commands[1].playlistEditEndpoint.actions.length, 2);
  assert.equal(origin.commands[1].playlistEditEndpoint.actions[1].setVideoId, 'second');
  await assert.rejects(adapter.editPlaylist(origin, OTHER, option, true), /недоступна/);
  await assert.rejects(adapter.editPlaylist(origin, VIDEO, option, false), /недоступна/);
  assert.equal(origin.commands.length, 2);
});

test('fresh removal identifiers take precedence over a cached native removal command', async () => {
  const adapter = setup();
  const origin = service(() => ({ success: true }));
  const option = { id: 'PL_music', removeEndpoint: playlistOption().playlistAddToOptionRenderer.removeFromPlaylistServiceEndpoint };
  await adapter.editPlaylist(origin, VIDEO, option, false, ['fresh-first', 'fresh-second']);
  assert.deepEqual(Array.from(origin.commands[0].playlistEditEndpoint.actions, (item) => item.setVideoId),
    ['fresh-first', 'fresh-second']);
});
