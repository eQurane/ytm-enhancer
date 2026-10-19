(() => {
  'use strict';
  const KEY = Symbol.for('ytmq.queue.v1');
  if (globalThis[KEY]) return;
  globalThis[KEY] = true;
  const adapter = globalThis[Symbol.for('ytmq.adapter.v1')];
  const rows = new Map();
  const confirmed = new Map();
  const pending = new Map();
  const requestRevisions = new Map();
  let enabled = false;
  let scheduled = false;
  let poll;
  let notice;
  let noticeTimer;
  let lastPlayer = '';
  const paths = {
    like: 'M2 10h4v12H2V10Zm6 12V10l5-8 2 1v5h5l2 2-3 12H8Zm2-2h7l2.8-9H13V6l-3 5v9Z',
    dislike: 'M2 2h4v12H2V2Zm6 0h11l3 12-2 2h-5v5l-2 1-5-8V2Zm2 2v9l3 5v-4h6.8L17 4h-7Z',
    save: 'M3 4h16v2H3V4Zm0 5h16v2H3V9Zm0 5h10v2H3v-2Zm14-1h2v4h4v2h-4v4h-2v-4h-4v-2h4v-4Z',
  };

  function button(icon, label) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'ytmq-button';
    element.title = label;
    element.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[icon]);
    svg.append(path);
    element.append(svg);
    return element;
  }

  function message(text) {
    if (!enabled) return;
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'ytmq-message';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      document.body.append(notice);
    }
    notice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice?.remove(); notice = null; }, 6500);
  }

  function remove(row, state) {
    state.controls.remove();
    row.classList.remove('ytmq-row');
    rows.delete(row);
  }

  function schedule() {
    if (!enabled || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (enabled) reconcile();
    });
  }

  function statusFor(entry) {
    return confirmed.get(entry.videoId) ?? entry.status;
  }

  function bind(state, entry) {
    state.entry = entry;
    state.status = statusFor(entry);
    if (state.rating) adapter.bindRating(state.rating, entry, state.status);
  }

  function create(row, entry) {
    const controls = document.createElement('div');
    controls.className = 'ytmq-actions';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Оценка и плейлист');
    const placeholders = document.createElement('div');
    placeholders.className = 'ytmq-placeholders';
    for (const [icon, label] of [['like', 'Нравится'], ['dislike', 'Не нравится']]) {
      const item = button(icon, label);
      item.disabled = true;
      placeholders.append(item);
    }
    const save = button('save', entry.saveLabel);
    controls.append(placeholders, save);
    const state = { controls, placeholders, save, rating: null, entry, status: null };
    rows.set(row, state);

    // Validate before the native component receives an input event. Queue DOM
    // nodes can be recycled without first being removed from the document.
    const guard = (event) => {
      if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
      const current = adapter.snapshot(row);
      if (!enabled || !row.isConnected || current?.videoId !== state.entry.videoId
        || pending.has(state.entry.videoId)
        || (state.rating?.contains(event.target) && !current?.canRate)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        schedule();
      } else if (event.type === 'click' || event.type === 'keydown' || event.type === 'tap') {
        // Refresh endpoints as well as the ID immediately before a real action.
        state.entry = current;
      }
    };
    for (const name of ['click', 'keydown', 'tap']) controls.addEventListener(name, guard, true);
    // Do not stop yt-action: it must reach YouTube Music's native command handler.
    for (const name of ['click', 'dblclick', 'tap', 'keydown', 'keyup']) {
      controls.addEventListener(name, (event) => event.stopPropagation());
    }
    save.addEventListener('click', async () => {
      const current = adapter.snapshot(row);
      if (!current?.canSave || current.videoId !== state.entry.videoId) return;
      const videoId = current.videoId;
      const token = {};
      pending.set(videoId, token);
      schedule();
      try {
        await adapter.saveToPlaylist(save, current);
      } catch (error) {
        message(error.message);
      } finally {
        if (pending.get(videoId) === token) pending.delete(videoId);
        schedule();
      }
    });
    row.classList.add('ytmq-row');
    row.insertBefore(controls, row.querySelector('.duration'));
    bind(state, entry);
    return state;
  }

  function reconcile() {
    const queue = document.querySelector('ytmusic-player-queue');
    for (const [row, state] of rows) {
      if (!row.isConnected || !queue?.contains(row)) remove(row, state);
    }
    if (!queue) return;
    const player = adapter.playerRating();
    const playerKey = player ? `${player.videoId}:${player.status}` : '';
    if (playerKey !== lastPlayer) {
      lastPlayer = playerKey;
      if (player?.status && !pending.has(player.videoId)) confirmed.set(player.videoId, player.status);
    }
    for (const row of queue.querySelectorAll('ytmusic-player-queue-item')) {
      const entry = adapter.snapshot(row);
      let state = rows.get(row);
      if (!entry) {
        if (state) remove(row, state);
        continue;
      }
      if (state && !row.contains(state.controls)) {
        remove(row, state);
        state = null;
      }
      state ??= create(row, entry);
      if (!state.rating && customElements.get('ytmusic-like-button-renderer')) {
        state.rating = document.createElement('ytmusic-like-button-renderer');
        state.rating.rawProps = { data: entry.likeData };
        controlsInsertRating(state);
        bind(state, entry);
      }
      if (state.entry.videoId !== entry.videoId || state.entry.source !== entry.source
        || state.entry.canRate !== entry.canRate || state.status !== statusFor(entry)) bind(state, entry);
      else state.entry = entry;

      const busy = pending.has(entry.videoId);
      const nativeButtons = state.rating?.querySelectorAll('button') ?? [];
      const nativeStatus = adapter.ratingOf(state.rating);
      if (!busy && nativeStatus && !confirmed.has(entry.videoId)
        && (entry.status !== null || nativeStatus !== 'INDIFFERENT')) {
        confirmed.set(entry.videoId, nativeStatus);
        state.status = nativeStatus;
      }
      const ready = entry.canRate && nativeButtons.length >= 2;
      state.placeholders.hidden = ready;
      if (state.rating) state.rating.hidden = !ready;
      state.controls.setAttribute('aria-busy', String(busy));
      state.save.disabled = busy || !entry.canSave;
      state.save.title = entry.canSave ? entry.saveLabel : 'Добавление в плейлист недоступно';
      state.save.setAttribute('aria-label', state.save.title);
      for (const item of nativeButtons) {
        item.disabled = busy || !entry.canRate;
        const label = item.getAttribute('aria-label');
        if (label && item.title !== label) item.title = label;
      }
    }
  }

  function controlsInsertRating(state) {
    state.controls.insertBefore(state.rating, state.save);
  }

  function syncStatus(videoId, status) {
    confirmed.set(videoId, status);
    for (const state of rows.values()) {
      if (state.entry.videoId === videoId && state.rating) {
        state.status = status;
        adapter.bindRating(state.rating, state.entry, status);
      }
    }
    const player = adapter.playerRating();
    if (player?.videoId === videoId) {
      const data = adapter.dataOf(player.renderer);
      adapter.setData(player.renderer, { ...data, likeStatus: status });
    }
  }

  // Observe native rating requests, including those from the player bar or menus.
  // Apply a shared status only after the site's request has actually succeeded.
  document.addEventListener('yt-action', (event) => {
    if (!enabled || event.detail?.actionName !== 'yt-service-request') return;
    const endpoint = event.detail.args?.[1]?.likeEndpoint;
    const videoId = endpoint?.target?.videoId;
    if (!adapter.isVideoId(videoId) || !adapter.isStatus(endpoint.status)) return;
    const previous = confirmed.get(videoId)
      ?? [...rows.values()].find((state) => state.entry.videoId === videoId)?.status;
    const revision = (requestRevisions.get(videoId) ?? 0) + 1;
    requestRevisions.set(videoId, revision);
    const token = {};
    pending.set(videoId, token);
    schedule();
    // returnValue is populated by an ancestor handler later in this dispatch.
    queueMicrotask(async () => {
      try {
        await adapter.responseOf(event.detail.returnValue);
        if (enabled && requestRevisions.get(videoId) === revision) syncStatus(videoId, endpoint.status);
      } catch (error) {
        if (enabled && requestRevisions.get(videoId) === revision) {
          if (previous) syncStatus(videoId, previous);
          else {
            // Restore unknown historical state without claiming a neutral rating.
            for (const state of rows.values()) {
              if (state.entry.videoId === videoId && state.rating) {
                adapter.bindRating(state.rating, state.entry, state.status);
              }
            }
          }
          message(error.message);
        }
      } finally {
        if (pending.get(videoId) === token) pending.delete(videoId);
        schedule();
      }
    });
  });

  const observer = new MutationObserver((mutations) => {
    // Ignore our own subtree and the player progress bar to avoid a render loop.
    if (mutations.some((item) => !item.target.closest?.('.ytmq-actions, .ytmq-message')
      && (item.target.closest?.('ytmusic-player-queue, ytmusic-player-bar ytmusic-like-button-renderer')
        || [...item.addedNodes, ...item.removedNodes].some((node) => node.nodeType === 1
          && (node.matches?.('ytmusic-player-queue') || node.querySelector?.('ytmusic-player-queue')))))) {
      schedule();
    }
  });

  function applySetting() {
    const next = document.documentElement.getAttribute('data-ytmq-enabled') === 'true';
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['like-status', 'unplayable'] });
      // Polymer can replace a row's data without a DOM mutation. A bounded
      // refresh also catches late custom-element registration and metadata.
      poll = setInterval(() => { if (!document.hidden) schedule(); }, 1000);
      schedule();
    } else {
      observer.disconnect();
      clearInterval(poll);
      for (const [row, state] of rows) remove(row, state);
      confirmed.clear();
      lastPlayer = '';
      clearTimeout(noticeTimer);
      notice?.remove();
      notice = null;
    }
  }

  new MutationObserver(applySetting).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-ytmq-enabled'],
  });
  document.addEventListener('yt-navigate-finish', schedule);
  document.addEventListener('yt-page-data-updated', schedule);
  document.addEventListener('visibilitychange', schedule);
  applySetting();
})();
