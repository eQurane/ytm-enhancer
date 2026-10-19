import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/settings-bridge.js', import.meta.url), 'utf8');
const preferences = await readFile(new URL('../src/shared/preferences.js', import.meta.url), 'utf8');

function setup() {
  let listener;
  let resolve;
  let reject;
  let runtimeListener;
  const attributes = new Map();
  const listeners = new Map();
  const writes = [];
  const document = {
    documentElement: { setAttribute: (key, value) => attributes.set(key, value) },
    addEventListener: (name, listener) => listeners.set(name, listener),
    dispatchEvent: (event) => listeners.get(event.type)?.(event),
  };
  vm.runInNewContext(preferences + source, {
    document, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    console: { error() {} },
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener: (fn) => { runtimeListener = fn; } } }, storage: {
      onChanged: { addListener: (callback) => { listener = callback; } },
      local: { get: () => new Promise((yes, no) => { resolve = yes; reject = no; }),
        set: async (value) => { writes.push(value); } },
    } },
  });
  return { attributes, change: (...args) => listener(...args),
    writes, document, listeners, message: (...args) => runtimeListener(...args),
    resolve: (value) => resolve(value), reject: (error) => reject(error) };
}

test('publishes the saved setting and ignores unrelated storage areas', async () => {
  const state = setup();
  state.resolve({ enabled: true });
  await Promise.resolve();
  assert.equal(state.attributes.get('data-ytmq-enabled'), 'true');
  state.change({ enabled: { newValue: false } }, 'sync');
  assert.equal(state.attributes.get('data-ytmq-enabled'), 'true');
  state.change({ enabled: { newValue: false } }, 'local');
  assert.equal(state.attributes.get('data-ytmq-enabled'), 'false');
});

test('merges racing settings per key and normalizes invalid values', async () => {
  const state = setup();
  state.change({ playlistModifier: { newValue: 'ctrl' } }, 'local');
  state.resolve({ enabled: false, defaultPlaylist: { id: 'PL_music', title: 'Music' }, playlistModifier: 'alt' });
  await Promise.resolve();
  let settings = JSON.parse(state.attributes.get('data-ytmq-settings'));
  assert.equal(settings.enabled, false);
  assert.equal(settings.playlistModifier, 'ctrl');
  assert.equal(settings.defaultPlaylist.id, 'PL_music');
  state.change({ defaultPlaylist: { newValue: { id: '../bad', title: 'bad' } }, playlistModifier: { newValue: 'meta' } }, 'local');
  settings = JSON.parse(state.attributes.get('data-ytmq-settings'));
  assert.equal(settings.defaultPlaylist, null);
  assert.equal(settings.playlistModifier, 'shift');
});

test('accepts only the extension list request and strips service commands from responses', async () => {
  const state = setup();
  state.resolve({ enabled: true });
  let answer;
  let id;
  state.document.addEventListener('ytmq-playlists-request', (event) => { id = JSON.parse(event.detail).id; });
  assert.equal(state.message({ type: 'ytmq:list-playlists' }, { id: 'other' }, () => {}), undefined);
  assert.equal(state.message({ type: 'arbitrary-command' }, { id: 'test-extension' }, () => {}), undefined);
  assert.equal(state.message({ type: 'ytmq:list-playlists' }, { id: 'test-extension' }, (value) => { answer = value; }), true);
  state.document.dispatchEvent({ type: 'ytmq-playlists-response', detail: JSON.stringify({ id, playlists: [
    { id: 'PL_music', title: 'Music', addEndpoint: { secret: 'must-not-cross' } }, { id: '../bad', title: 'Bad' },
  ] }) });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), { playlists: [{ id: 'PL_music', title: 'Music' }] });
});

test('validates playlist preferences before writing and acknowledges the request', async () => {
  const state = setup();
  state.resolve({ enabled: true });
  let response;
  state.document.addEventListener('ytmq-default-playlist-response', (event) => { response = JSON.parse(event.detail); });
  state.document.dispatchEvent({ type: 'ytmq-default-playlist-request', detail: '{broken' });
  state.document.dispatchEvent({ type: 'ytmq-default-playlist-request', detail: JSON.stringify({ id: 'bad', playlist: { id: '../bad', title: 'Bad' } }) });
  assert.equal(state.writes.length, 0);
  state.document.dispatchEvent({ type: 'ytmq-default-playlist-request', detail: JSON.stringify({ id: 'good', playlist: { id: 'PL_music', title: 'Music', command: 'bad' } }) });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(state.writes)), [{ defaultPlaylist: { id: 'PL_music', title: 'Music' } }]);
  assert.deepEqual(response, { id: 'good' });
});

test('an initial read cannot overwrite a more recent toggle', async () => {
  const state = setup();
  state.change({ enabled: { newValue: false } }, 'local');
  state.resolve({ enabled: true });
  await Promise.resolve();
  assert.equal(state.attributes.get('data-ytmq-enabled'), 'false');
});

test('fails closed when storage is unavailable and restores defaults on deletion', async () => {
  const state = setup();
  state.reject(new Error('Extension context invalidated'));
  await new Promise(setImmediate);
  assert.equal(state.attributes.get('data-ytmq-enabled'), 'false');
  state.change({ enabled: {} }, 'local');
  assert.equal(state.attributes.get('data-ytmq-enabled'), 'true');
});
