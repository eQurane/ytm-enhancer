import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/content/playlist-store.js', import.meta.url), 'utf8');
function setup(overrides = {}) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const factory = vm.runInContext("globalThis[Symbol.for('ytmq.playlist-store.v1')]", context);
  let time = 0;
  const calls = { lists: 0, reads: 0, edits: [] };
  const adapter = {
    async listPlaylists(origin, videoId) { calls.lists += 1; return [{ id: 'PL_music', title: 'Music', contains: null, videoId }]; },
    async readPlaylist() { calls.reads += 1; return new Map([['old-song', ['set-old']]]); },
    async editPlaylist(...args) { calls.edits.push(args); },
    ...overrides,
  };
  const store = factory.create(adapter, () => {}, () => time);
  return { store, calls, adapter, tick: (ms) => { time += ms; } };
}

test('deduplicates song reads and shares historical playlist contents across songs for 60 seconds', async () => {
  const { store, calls, tick } = setup();
  const [old, duplicate, other] = await Promise.all([
    store.load({}, 'old-song', 'PL_music'), store.load({}, 'old-song', 'PL_music'), store.load({}, 'new-song', 'PL_music'),
  ]);
  assert.equal(old, duplicate);
  assert.equal(old.contains, true);
  assert.equal(other.contains, false);
  assert.equal(calls.lists, 2);
  assert.equal(calls.reads, 1);
  await store.load({}, 'old-song', 'PL_music');
  assert.equal(calls.lists, 2);
  tick(60001);
  await store.load({}, 'old-song', 'PL_music');
  assert.equal(calls.lists, 3);
  assert.equal(calls.reads, 2);
});

test('limits all concurrent requests to three', async () => {
  let active = 0;
  let peak = 0;
  const { store } = setup({ async listPlaylists() {
    active += 1;
    peak = Math.max(active, peak);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return [{ id: 'PL_music', contains: false }];
  } });
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.load({}, `song-${i}`, 'PL_music')));
  assert.equal(peak, 3);
});

test('late results cannot repopulate state after default playlist changes', async () => {
  let finish;
  const { store } = setup({ listPlaylists: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = store.load({}, 'song', 'PL_music');
  await Promise.resolve();
  store.reset();
  finish([{ id: 'PL_music', contains: true }]);
  await assert.rejects(pending, /изменились/);
  assert.equal(store.peek('song', 'PL_music'), undefined);
});

test('toggle checks membership and identity before modifying and updates confirmed state only after success', async () => {
  const { store, calls, adapter } = setup();
  const result = await store.toggle({}, 'old-song', 'PL_music');
  assert.equal(result.added, false);
  assert.equal(calls.edits[0][3], false);
  assert.deepEqual(calls.edits[0][4], ['set-old']);
  assert.equal(store.peek('old-song', 'PL_music').contains, false);
  await assert.rejects(store.toggle({}, 'new-song', 'PL_music', () => false), /изменились/);
  assert.equal(calls.edits.length, 1);
  adapter.editPlaylist = async () => { throw new Error('offline'); };
  await assert.rejects(store.toggle({}, 'new-song', 'PL_music'), /offline/);
  assert.equal(store.peek('new-song', 'PL_music').contains, false);
});

test('unavailable defaults never fall back to another playlist and errors are cached', async () => {
  const { store, calls, adapter, tick } = setup();
  await store.load({}, 'old-song', 'PL_music');
  adapter.listPlaylists = async () => { calls.lists += 1; return [{ id: 'PL_other', contains: false }]; };
  await assert.rejects(store.toggle({}, 'old-song', 'PL_music'), /недоступен/);
  assert.equal(calls.edits.length, 0);
  assert.equal(store.peek('old-song', 'PL_music').contains, true);
  const count = calls.lists;
  await assert.rejects(store.load({}, 'old-song', 'PL_music'), /недоступен/);
  assert.equal(calls.lists, count);
  tick(60001);
  await assert.rejects(store.load({}, 'old-song', 'PL_music'), /недоступен/);
  assert.equal(calls.lists, count + 1);
});

test('choosing an existing destination never removes a song or adds a duplicate', async () => {
  const { store, calls } = setup();
  await store.toggle({}, 'old-song', 'PL_music', () => true, true);
  assert.equal(calls.edits.length, 0);
  assert.equal(store.peek('old-song', 'PL_music').contains, true);
});

test('native invalidation during a successful edit discards stale state without reporting failure', async () => {
  const { store, adapter } = setup();
  adapter.editPlaylist = async () => { store.reset(); };
  const result = await store.toggle({}, 'new-song', 'PL_music');
  assert.equal(result.added, true);
  assert.equal(store.peek('new-song', 'PL_music'), undefined);
});
