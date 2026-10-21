import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/content/playlist-store.js', import.meta.url), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

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

test('user actions bypass stale picker membership and native removal identifiers', async () => {
  const { store, calls } = setup({
    async listPlaylists() { return [{ id: 'PL_music', title: 'Music', contains: false }]; },
  });
  await store.toggle({}, 'old-song', 'PL_music');
  assert.equal(calls.reads, 1);
  assert.equal(calls.edits[0][3], false);
  assert.deepEqual(calls.edits[0][4], ['set-old']);
});

test('conflicts recheck membership and preserve the original intended state', async () => {
  let present = false;
  let edits = 0;
  const { store } = setup({
    async readPlaylist() { return new Map(present ? [['song', ['current']]] : []); },
    async editPlaylist() {
      edits += 1;
      present = true; // Another tab added the song while our request was in flight.
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
  });
  const result = await store.toggle({}, 'song', 'PL_music');
  assert.equal(result.added, true);
  assert.equal(edits, 1);
  assert.equal(store.peek('song', 'PL_music').contains, true);
});

test('only retries a conflict once with fresh identifiers, and does not retry network failures', async () => {
  let reads = 0;
  let edits = 0;
  const { store, adapter } = setup({
    async readPlaylist() { reads += 1; return new Map([['song', [`set-${reads}`]]]); },
    async editPlaylist(origin, videoId, option, add, setIds) {
      edits += 1;
      assert.equal(add, false);
      assert.deepEqual(setIds, [`set-${edits}`]);
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
  });
  await assert.rejects(store.toggle({}, 'song', 'PL_music'), /conflict/);
  assert.equal(edits, 2);
  adapter.editPlaylist = async () => { edits += 1; throw new Error('offline'); };
  await assert.rejects(store.toggle({}, 'song', 'PL_music'), /offline/);
  assert.equal(edits, 3);
});

test('serializes membership checks and edits for the same playlist while other playlists can proceed', async () => {
  let release;
  const started = [];
  const listed = [];
  const { store } = setup({
    async listPlaylists(origin, videoId) {
      listed.push(videoId);
      return ['PL_music', 'PL_other'].map((id) => ({ id, title: id, contains: false }));
    },
    async readPlaylist() { return new Map(); },
    async editPlaylist(origin, videoId) {
      started.push(videoId);
      if (videoId === 'first') await new Promise((resolve) => { release = resolve; });
    },
  });
  const first = store.toggle({}, 'first', 'PL_music');
  while (!release) await new Promise(setImmediate);
  const second = store.toggle({}, 'second', 'PL_music');
  await store.toggle({}, 'other', 'PL_other');
  assert.deepEqual(started, ['first', 'other']);
  assert.deepEqual(listed, ['first', 'other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(started, ['first', 'other', 'second']);
});

test('forced loads bypass cached contents and both stale picker states with removal commands', async () => {
  for (const pickerContains of [false, true]) {
    let current = new Map();
    let reads = 0;
    const { store, calls } = setup({
      async listPlaylists(origin, videoId) {
        return [{ id: 'PL_music', contains: videoId === 'background' ? null : pickerContains,
          removeEndpoint: { stale: true } }];
      },
      async readPlaylist() { reads += 1; return current; },
    });
    await store.load({}, 'background', 'PL_music');
    current = new Map(pickerContains ? [] : [['song', ['fresh-first', 'fresh-second']]]);
    const result = await store.toggle({}, 'song', 'PL_music');
    assert.equal(result.added, pickerContains);
    assert.equal(reads, 2);
    assert.equal(calls.edits[0][3], pickerContains);
    assert.deepEqual(Array.from(calls.edits[0][4]), pickerContains ? [] : ['fresh-first', 'fresh-second']);
  }
});

test('forced reads do not reuse an in-flight background contents request', async () => {
  const started = deferred();
  const stale = deferred();
  let reads = 0;
  const { store, calls } = setup({ async readPlaylist() {
    reads += 1;
    if (reads === 1) { started.resolve(); return stale.promise; }
    return new Map([['song', ['fresh']]]);
  } });
  const background = store.load({}, 'background', 'PL_music');
  await started.promise;
  const result = await store.toggle({}, 'song', 'PL_music');
  assert.equal(result.added, false);
  assert.equal(reads, 2);
  assert.deepEqual(calls.edits[0][4], ['fresh']);
  stale.resolve(new Map());
  await background;
  assert.equal(store.peek('song', 'PL_music').contains, false);
});

test('failed complete reads prevent edits even when the picker supplies a command', async () => {
  const { store, calls } = setup({
    async listPlaylists() { return [{ id: 'PL_music', contains: true, removeEndpoint: { stale: true } }]; },
    async readPlaylist() { throw new Error('later page offline'); },
  });
  await assert.rejects(store.toggle({}, 'song', 'PL_music'), /later page offline/);
  assert.equal(calls.edits.length, 0);
});

test('a removal conflict succeeds when another client has already removed the song', async () => {
  let present = true;
  let edits = 0;
  const { store } = setup({
    async readPlaylist() { return new Map(present ? [['song', ['old']]] : []); },
    async editPlaylist(origin, videoId, option, add) {
      assert.equal(add, false);
      edits += 1;
      present = false;
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
  });
  const result = await store.toggle({}, 'song', 'PL_music');
  assert.equal(result.added, false);
  assert.equal(edits, 1);
  assert.equal(store.peek('song', 'PL_music').contains, false);
});

test('a successful retry uses fresh options and identifiers without reversing the intent', async () => {
  let reads = 0;
  let lists = 0;
  const edits = [];
  const { store } = setup({
    async listPlaylists() { lists += 1; return [{ id: 'PL_music', title: `title-${lists}`, contains: false }]; },
    async readPlaylist() { reads += 1; return new Map([['song', [`set-${reads}`]]]); },
    async editPlaylist(origin, videoId, option, add, setIds) {
      edits.push({ option, add, setIds });
      if (edits.length === 1) throw Object.assign(new Error('conflict'), { status: 409 });
    },
  });
  const result = await store.toggle({}, 'song', 'PL_music');
  assert.equal(result.added, false);
  assert.equal(result.title, 'title-2');
  assert.deepEqual(edits.map(({ option, add, setIds }) => [option.title, add, ...setIds]),
    [['title-1', false, 'set-1'], ['title-2', false, 'set-2']]);
  assert.equal(store.peek('song', 'PL_music').contains, false);
});

test('failed conflict rechecks propagate without issuing a second edit', async () => {
  let reads = 0;
  let edits = 0;
  const { store } = setup({
    async readPlaylist() {
      reads += 1;
      if (reads === 2) throw new Error('recheck offline');
      return new Map();
    },
    async editPlaylist() { edits += 1; throw Object.assign(new Error('conflict'), { status: 409 }); },
  });
  await assert.rejects(store.toggle({}, 'song', 'PL_music'), /recheck offline/);
  assert.equal(reads, 2);
  assert.equal(edits, 1);
});

test('a failed queued operation does not block the next operation', async () => {
  const edits = [];
  const { store } = setup({
    async editPlaylist(origin, videoId) {
      edits.push(videoId);
      if (videoId === 'first') throw new Error('offline');
    },
  });
  const results = await Promise.allSettled([
    store.toggle({}, 'first', 'PL_music'), store.toggle({}, 'second', 'PL_music'),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /offline/);
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(edits, ['first', 'second']);
});

test('the playlist queue stays locked throughout a conflict recheck and retry', async () => {
  const rechecking = deferred();
  const release = deferred();
  let reads = 0;
  let firstAttempts = 0;
  const listed = [];
  const edited = [];
  const { store } = setup({
    async listPlaylists(origin, videoId) {
      listed.push(videoId);
      return ['PL_music', 'PL_other'].map((id) => ({ id, contains: false }));
    },
    async readPlaylist(origin, playlistId) {
      if (playlistId === 'PL_music' && ++reads === 2) {
        rechecking.resolve();
        await release.promise;
      }
      return new Map();
    },
    async editPlaylist(origin, videoId) {
      edited.push(videoId);
      if (videoId === 'first' && ++firstAttempts === 1) {
        throw Object.assign(new Error('conflict'), { status: 409 });
      }
    },
  });
  const first = store.toggle({}, 'first', 'PL_music');
  await rechecking.promise;
  const second = store.toggle({}, 'second', 'PL_music');
  await store.toggle({}, 'other', 'PL_other');
  assert.deepEqual(listed, ['first', 'first', 'other']);
  assert.deepEqual(edited, ['first', 'other']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(edited, ['first', 'other', 'first', 'second']);
});

test('reset cancels old queued actions while allowing a new generation to proceed', async () => {
  const started = deferred();
  const stale = deferred();
  let reads = 0;
  const listed = [];
  const { store, calls } = setup({
    async listPlaylists(origin, videoId) { listed.push(videoId); return [{ id: 'PL_music', contains: null }]; },
    async readPlaylist() {
      reads += 1;
      if (reads === 1) { started.resolve(); return stale.promise; }
      return new Map();
    },
  });
  const first = assert.rejects(store.toggle({}, 'first', 'PL_music'), /изменились/);
  await started.promise;
  const queued = assert.rejects(store.toggle({}, 'queued', 'PL_music'), /изменились/);
  store.reset();
  await store.toggle({}, 'fresh', 'PL_music');
  stale.resolve(new Map());
  await Promise.all([first, queued]);
  assert.deepEqual(listed, ['first', 'fresh']);
  assert.deepEqual(calls.edits.map((args) => args[1]), ['fresh']);
  assert.equal(store.peek('first', 'PL_music'), undefined);
  assert.equal(store.peek('fresh', 'PL_music').contains, true);
});

test('reset during a wait for a background song read does not restart the old action', async () => {
  const started = deferred();
  const stale = deferred();
  const { store, calls } = setup({ async readPlaylist() { started.resolve(); return stale.promise; } });
  const background = assert.rejects(store.load({}, 'song', 'PL_music'), /изменились/);
  await started.promise;
  const action = assert.rejects(store.toggle({}, 'song', 'PL_music'), /изменились/);
  await new Promise(setImmediate);
  store.reset();
  stale.resolve(new Map());
  await Promise.all([background, action]);
  assert.equal(calls.lists, 1);
  assert.equal(calls.edits.length, 0);
  assert.equal(store.peek('song', 'PL_music'), undefined);
});

test('reset on a conflict or during its recheck cancels the retry', async () => {
  for (const resetDuringRecheck of [false, true]) {
    let reads = 0;
    let edits = 0;
    const { store } = setup({
      async readPlaylist() {
        reads += 1;
        if (resetDuringRecheck && reads === 2) store.reset();
        return new Map();
      },
      async editPlaylist() {
        edits += 1;
        if (!resetDuringRecheck) store.reset();
        throw Object.assign(new Error('conflict'), { status: 409 });
      },
    });
    await assert.rejects(store.toggle({}, 'song', 'PL_music'), /изменились/);
    assert.equal(reads, resetDuringRecheck ? 2 : 1);
    assert.equal(edits, 1);
    assert.equal(store.peek('song', 'PL_music'), undefined);
  }
});

test('song validity is rechecked before a conflict retry', async () => {
  let valid = true;
  let edits = 0;
  const { store } = setup({ async editPlaylist() {
    edits += 1;
    valid = false;
    throw Object.assign(new Error('conflict'), { status: 409 });
  } });
  await assert.rejects(store.toggle({}, 'song', 'PL_music', () => valid), /изменились/);
  assert.equal(edits, 1);
});

test('reads, edits and conflict retries across playlist queues share the three-request limit', async () => {
  let active = 0;
  let peak = 0;
  const attempts = new Map();
  const playlistIds = Array.from({ length: 5 }, (_, i) => `PL_${i}`);
  const request = async (work) => {
    active += 1;
    peak = Math.max(peak, active);
    try { await new Promise(setImmediate); return work(); }
    finally { active -= 1; }
  };
  const { store } = setup({
    listPlaylists: () => request(() => playlistIds.map((id) => ({ id, contains: false }))),
    readPlaylist: () => request(() => new Map()),
    editPlaylist: (origin, videoId) => request(() => {
      const attempt = (attempts.get(videoId) ?? 0) + 1;
      attempts.set(videoId, attempt);
      if (attempt === 1) throw Object.assign(new Error('conflict'), { status: 409 });
    }),
  });
  await Promise.all(playlistIds.flatMap((id) => [
    store.toggle({}, `${id}-first`, id), store.toggle({}, `${id}-second`, id),
  ]));
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(attempts.size, 10);
  assert.ok([...attempts.values()].every((count) => count === 2));
});
