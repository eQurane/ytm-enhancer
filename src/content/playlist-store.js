(() => {
  'use strict';
  const key = Symbol.for('ytmq.playlist-store.v1');
  if (globalThis[key]) return;

  // One limiter covers reads and writes, including popup requests and pagination.
  function create(adapter, notify = () => {}, now = Date.now) {
    const entries = new Map();
    const contents = new Map();
    const reads = new Map();
    const queues = new Map();
    const jobs = [];
    let active = 0;
    let revision = 0;
    const ttl = 60000;

    function run(work) {
      return new Promise((resolve, reject) => {
        jobs.push({ work, resolve, reject });
        pump();
      });
    }
    function pump() {
      while (active < 3 && jobs.length) {
        const job = jobs.shift();
        active += 1;
        Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { active -= 1; pump(); });
      }
    }
    function reset() {
      revision += 1;
      entries.clear();
      contents.clear();
      reads.clear();
      queues.clear();
      for (const job of jobs.splice(0)) job.reject(new Error('Настройки изменились. Повторите действие.'));
    }
    function check(epoch) {
      if (epoch !== revision) throw new Error('Настройки изменились. Повторите действие.');
    }
    function peek(videoId, playlistId) {
      return entries.get(`${playlistId}:${videoId}`);
    }
    function enqueue(playlistId, work) {
      const result = (queues.get(playlistId) ?? Promise.resolve()).then(work);
      const finish = () => { if (queues.get(playlistId) === tail) queues.delete(playlistId); };
      const tail = result.then(finish, finish);
      queues.set(playlistId, tail);
      return result;
    }
    async function playlistContents(origin, playlistId, epoch, force) {
      let record = contents.get(playlistId);
      if (!force && record?.expires > now()) return record.value;
      if (!force && record?.promise) return record.promise;
      record = {};
      contents.set(playlistId, record);
      record.promise = run(() => { check(epoch); return adapter.readPlaylist(origin, playlistId); }).then((value) => {
        check(epoch);
        record.value = value;
        record.expires = now() + ttl;
        return value;
      }).finally(() => { delete record.promise; });
      return record.promise;
    }
    async function list(origin, videoId) {
      const epoch = revision;
      const options = await run(() => { check(epoch); return adapter.listPlaylists(origin, videoId); });
      check(epoch);
      return options;
    }
    function load(origin, videoId, playlistId, { force = false } = {}) {
      return loadAt(origin, videoId, playlistId, force, revision);
    }
    function loadAt(origin, videoId, playlistId, force, epoch) {
      if (epoch !== revision) return Promise.reject(new Error('Настройки изменились. Повторите действие.'));
      const id = `${playlistId}:${videoId}`;
      const cached = entries.get(id);
      if (!force && cached?.expires > now()) {
        return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached);
      }
      if (reads.has(id)) {
        return force ? reads.get(id).catch(() => {}).then(() => loadAt(origin, videoId, playlistId, true, epoch))
          : reads.get(id);
      }
      // A user action must recheck membership even if another tab edited the
      // playlist since the background read; otherwise an add can create a duplicate.
      if (force) contents.delete(playlistId);
      const promise = (async () => {
        const options = await list(origin, videoId);
        check(epoch);
        const option = options.find((item) => item.id === playlistId);
        if (!option) throw new Error('Плейлист по умолчанию недоступен. Выберите другой в настройках.');
        let contains = option.contains;
        let setIds = [];
        if (force || contains === null || (contains && !option.removeEndpoint)) {
          const videos = await playlistContents(origin, playlistId, epoch, force);
          contains = videos.has(videoId);
          setIds = videos.get(videoId) ?? [];
        }
        check(epoch);
        const value = { contains, option, setIds, expires: now() + ttl };
        entries.set(id, value);
        notify();
        return value;
      })().catch((error) => {
        if (epoch === revision) {
          // Keep the last confirmed appearance on transient read failures.
          entries.set(id, { ...cached, error, expires: now() + ttl });
          notify();
        }
        throw error;
      }).finally(() => { if (reads.get(id) === promise) reads.delete(id); });
      reads.set(id, promise);
      return promise;
    }
    async function toggle(origin, videoId, playlistId, stillValid = () => true, desired) {
      const epoch = revision;
      return enqueue(playlistId, async () => {
        check(epoch);
        let entry = await loadAt(origin, videoId, playlistId, true, epoch);
        const add = desired ?? !entry.contains;
        const edit = () => run(() => {
          check(epoch);
          if (!stillValid()) throw new Error('Песня или настройки изменились. Повторите действие.');
          if (add === entry.contains) return;
          return adapter.editPlaylist(origin, videoId, entry.option, add, entry.setIds);
        });
        try {
          await edit();
        } catch (error) {
          if (error?.status !== 409) throw error;
          check(epoch);
          entry = await loadAt(origin, videoId, playlistId, true, epoch);
          await edit();
        }
        // A native response can itself invalidate cached playlist data. Once the
        // edit was confirmed, that is success; only discard the stale cache write.
        if (epoch === revision) {
          contents.delete(playlistId);
          entries.set(`${playlistId}:${videoId}`, { ...entry, contains: add, error: undefined, expires: now() + ttl });
        }
        notify();
        return { added: add, title: entry.option.title };
      });
    }
    return Object.freeze({ peek, load, list, toggle, reset });
  }
  globalThis[key] = Object.freeze({ create });
})();
