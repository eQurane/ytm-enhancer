(() => {
  'use strict';
  const KEY = Symbol.for('ytmq.queue.v1');
  if (globalThis[KEY]) return;
  globalThis[KEY] = true;
  const adapter = globalThis[Symbol.for('ytmq.adapter.v1')];
  const playlists = globalThis[Symbol.for('ytmq.playlist-store.v1')].create(adapter, schedule);
  const rows = new Map();
  const confirmed = new Map();
  const pending = new Map();
  const saving = new Map();
  const busyFor = (videoId) => pending.has(videoId) || saving.has(videoId);
  const requestRevisions = new Map();
  let enabled = false;
  let scheduled = false;
  let poll;
  let notice;
  let noticeTimer;
  let lastPlayer = '';
  let lastAccount = adapter.accountKey();
  let settings = { defaultPlaylist: null, playlistModifier: 'shift' };
  let picker;
  let preferenceSequence = 0;
  const visibleRows = new Set();
  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleRows.add(entry.target);
      else visibleRows.delete(entry.target);
    }
    schedule();
  });
  const paths = {
    like: 'M2 10h4v12H2V10Zm6 12V10l5-8 2 1v5h5l2 2-3 12H8Zm2-2h7l2.8-9H13V6l-3 5v9Z',
    dislike: 'M2 2h4v12H2V2Zm6 0h11l3 12-2 2h-5v5l-2 1-5-8V2Zm2 2v9l3 5v-4h6.8L17 4h-7Z',
    save: 'M3 4h16v2H3V4Zm0 5h16v2H3V9Zm0 5h10v2H3v-2Zm14-1h2v4h4v2h-4v4h-2v-4h-4v-2h4v-4Z',
    saved: 'm4 12 5 5L21 5l-1.5-1.5L9 14 5.5 10.5Z',
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
    if (picker?.state === state) closePicker(false);
    visibility.unobserve(row);
    visibleRows.delete(row);
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
    if (picker?.state === state && entry.videoId !== picker.videoId) closePicker(false);
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
    const ratingSlot = document.createElement('div');
    ratingSlot.className = 'ytmq-rating-slot';
    const saveSlot = document.createElement('div');
    saveSlot.className = 'ytmq-save-slot';
    ratingSlot.append(placeholders);
    saveSlot.append(save);
    controls.append(ratingSlot, saveSlot);
    const state = { controls, placeholders, save, ratingSlot, saveSlot, rating: null, entry, status: null };
    rows.set(row, state);
    visibility.observe(row);

    // Validate before the native component receives an input event. Queue DOM
    // nodes can be recycled without first being removed from the document.
    const guard = (event) => {
      if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
      const current = adapter.snapshot(row);
      if (!enabled || !row.isConnected || current?.videoId !== state.entry.videoId
        || busyFor(state.entry.videoId)
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
    save.addEventListener('keydown', (event) => {
      if (['Enter', ' ', 'Spacebar'].includes(event.key)) state.keyboardAlternative = event[`${settings.playlistModifier}Key`];
    });
    save.addEventListener('blur', () => { state.keyboardAlternative = false; });
    save.addEventListener('click', async (event) => {
      const current = adapter.snapshot(row);
      if (!current?.canSave || current.videoId !== state.entry.videoId) return;
      const videoId = current.videoId;
      const token = {};
      saving.set(videoId, token);
      schedule();
      try {
        const alternative = event[`${settings.playlistModifier}Key`] || (event.detail === 0 && state.keyboardAlternative);
        state.keyboardAlternative = false;
        const selected = settings.defaultPlaylist;
        const valid = () => enabled && row.isConnected && adapter.snapshot(row)?.videoId === videoId;
        if (alternative || !selected) {
          const options = await playlists.list(save, videoId);
          if (valid()) openPicker(row, state, options, !alternative && !selected);
        } else {
          const result = await playlists.toggle(save, videoId, selected.id,
            () => valid() && settings.defaultPlaylist?.id === selected.id);
          message(`${result.added ? 'Добавлено в' : 'Удалено из'} «${result.title}»`);
        }
      } catch (error) {
        message(error.message);
      } finally {
        if (saving.get(videoId) === token) saving.delete(videoId);
        schedule();
      }
    });
    row.classList.add('ytmq-row');
    row.insertBefore(controls, row.querySelector('.duration'));
    bind(state, entry);
    return state;
  }

  function reconcile() {
    const account = adapter.accountKey();
    if (lastAccount !== account) {
      lastAccount = account;
      playlists.reset();
      confirmed.clear();
      lastPlayer = '';
      closePicker(false);
    }
    if (picker && picker.state.entry.videoId !== picker.videoId) closePicker(false);
    const queue = document.querySelector('ytmusic-player-queue');
    for (const [row, state] of rows) {
      if (!row.isConnected || !queue?.contains(row)) remove(row, state);
    }
    if (!queue) return;
    const player = adapter.playerRating();
    const playerKey = player ? `${player.videoId}:${player.status}` : '';
    if (playerKey !== lastPlayer) {
      lastPlayer = playerKey;
      if (player?.status && !busyFor(player.videoId)) confirmed.set(player.videoId, player.status);
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

      const busy = busyFor(entry.videoId);
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
      state.ratingSlot.classList.toggle('ytmq-reveal', busy);
      const selected = settings.defaultPlaylist;
      const saved = selected ? playlists.peek(entry.videoId, selected.id) : null;
      const present = saved?.contains === true;
      state.saveSlot.classList.toggle('ytmq-reveal', busy || present || picker?.state === state);
      state.save.setAttribute('aria-pressed', String(present));
      state.save.setAttribute('aria-haspopup', 'dialog');
      state.save.setAttribute('aria-expanded', String(picker?.state === state));
      state.save.querySelector('path').setAttribute('d', present ? paths.saved : paths.save);
      state.save.disabled = busy || !entry.canSave;
      const modifier = { shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt' }[settings.playlistModifier];
      state.save.title = !entry.canSave ? 'Добавление в плейлист недоступно'
        : selected ? `${present ? 'Удалить из' : 'Добавить в'} «${selected.title}». ${modifier} + клик — другой плейлист`
          : `Выбрать плейлист по умолчанию. ${modifier} + клик — другой плейлист`;
      state.save.setAttribute('aria-label', state.save.title);
      if (selected && entry.canSave && visibleRows.has(row) && !document.hidden && !busy) {
        playlists.load(state.save, entry.videoId, selected.id).catch(() => {});
      }
      for (const item of nativeButtons) {
        item.disabled = busy || !entry.canRate;
        const label = item.getAttribute('aria-label');
        if (label && item.title !== label) item.title = label;
      }
    }
  }

  function controlsInsertRating(state) {
    state.ratingSlot.append(state.rating);
  }

  function closePicker(restoreFocus = true) {
    if (!picker) return;
    const { element, state } = picker;
    picker = null;
    element.remove();
    state.save.setAttribute('aria-expanded', 'false');
    if (restoreFocus && state.save.isConnected) state.save.focus({ preventScroll: true });
    schedule();
  }

  function rememberPlaylist(playlist) {
    const id = `queue-${++preferenceSequence}`;
    return new Promise((resolve, reject) => {
      const finish = (event) => {
        let response;
        try { response = JSON.parse(event.detail); } catch { return; }
        if (response.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener('ytmq-default-playlist-response', finish);
        if (response.error) reject(new Error(response.error));
        else resolve();
      };
      const timer = setTimeout(() => {
        document.removeEventListener('ytmq-default-playlist-response', finish);
        reject(new Error('Не удалось сохранить настройку. Обновите вкладку музыки.'));
      }, 10000);
      document.addEventListener('ytmq-default-playlist-response', finish);
      document.dispatchEvent(new CustomEvent('ytmq-default-playlist-request', {
        detail: JSON.stringify({ id, playlist: { id: playlist.id, title: playlist.title } }),
      }));
    });
  }

  function openPicker(row, state, options, makeDefault) {
    closePicker(false);
    const videoId = state.entry.videoId;
    const element = document.createElement('div');
    element.className = 'ytmq-picker';
    for (const type of ['click', 'dblclick', 'tap', 'keydown', 'keyup']) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Выбрать плейлист');
    const header = document.createElement('div');
    header.className = 'ytmq-picker-header';
    const title = document.createElement('strong');
    title.textContent = 'Выбрать плейлист';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Закрыть выбор плейлиста');
    close.addEventListener('click', () => closePicker());
    header.append(title, close);
    const label = document.createElement('label');
    label.className = 'ytmq-default-choice';
    const remember = document.createElement('input');
    remember.type = 'checkbox';
    remember.checked = makeDefault;
    label.append(remember, document.createTextNode('Сделать по умолчанию'));
    const list = document.createElement('div');
    list.className = 'ytmq-playlist-choices';
    const status = document.createElement('p');
    status.className = 'ytmq-picker-status';
    status.setAttribute('role', 'status');
    if (!options.length) status.textContent = 'Нет доступных для редактирования плейлистов.';
    for (const option of options) {
      const item = document.createElement('button');
      item.type = 'button';
      const cached = playlists.peek(videoId, option.id);
      const contains = cached?.contains ?? option.contains;
      item.textContent = `${contains === true ? '✓ ' : ''}${option.title}`;
      item.title = `${contains === true ? 'Уже в' : 'Добавить в'} «${option.title}»`;
      item.addEventListener('click', async () => {
        if (busyFor(videoId)) return;
        const valid = () => enabled && row.isConnected && adapter.snapshot(row)?.videoId === videoId;
        if (!valid()) { closePicker(false); return; }
        const token = {};
        const currentPicker = picker;
        const shouldRemember = remember.checked;
        saving.set(videoId, token);
        for (const control of element.querySelectorAll('button, input')) control.disabled = true;
        status.textContent = 'Сохранение…';
        schedule();
        try {
          // Selecting a destination adds without creating duplicates. Removal
          // is the explicit checked-button action for the default playlist.
          const result = await playlists.toggle(state.save, videoId, option.id, valid, true);
          if (shouldRemember && valid()) await rememberPlaylist(option);
          if (picker === currentPicker) closePicker();
          message(`${result.added ? 'Добавлено в' : 'Удалено из'} «${result.title}»`);
        } catch (error) {
          status.textContent = error.message;
          message(error.message);
        } finally {
          if (saving.get(videoId) === token) saving.delete(videoId);
          for (const control of element.querySelectorAll('button, input')) control.disabled = false;
          schedule();
        }
      });
      list.append(item);
    }
    element.append(header, label, list, status);
    document.body.append(element);
    picker = { element, state, videoId };
    const rect = state.save.getBoundingClientRect();
    const width = element.getBoundingClientRect().width;
    element.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
    const height = element.getBoundingClientRect().height;
    element.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - height - 8))}px`;
    state.save.setAttribute('aria-expanded', 'true');
    (list.querySelector('button') ?? close).focus({ preventScroll: true });
    schedule();
  }

  document.addEventListener('pointerdown', (event) => {
    if (picker && !picker.element.contains(event.target) && !picker.state.save.contains(event.target)) closePicker();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (picker && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closePicker();
    }
  }, true);
  document.addEventListener('focusin', (event) => {
    if (picker && !picker.element.contains(event.target) && !picker.state.save.contains(event.target)) closePicker(false);
  });
  document.addEventListener('scroll', (event) => {
    if (picker && !picker.element.contains(event.target)) closePicker(false);
  }, true);
  globalThis.addEventListener('resize', () => closePicker(false));

  // Metadata for the extension popup is available even when queue controls are disabled.
  document.addEventListener('ytmq-playlists-request', async (event) => {
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (typeof request.id !== 'string' || request.id.length > 100) return;
    const response = { id: request.id };
    try {
      const anchor = document.querySelector('ytmusic-app') ?? document.body;
      const entries = [...document.querySelectorAll('ytmusic-player-queue-item')].map(adapter.snapshot);
      const videoId = entries.find((entry) => entry?.canSave)?.videoId ?? adapter.playerRating()?.videoId;
      response.playlists = (await playlists.list(anchor, videoId)).map(({ id, title }) => ({ id, title }));
    } catch (error) { response.error = error.message; }
    document.dispatchEvent(new CustomEvent('ytmq-playlists-response', { detail: JSON.stringify(response) }));
  });

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
    const command = event.detail.args?.[1];
    if (command?.playlistEditEndpoint && !event.detail.args?.[0]?.closest?.('.ytmq-actions')) {
      queueMicrotask(async () => {
        try { await adapter.responseOf(event.detail.returnValue); playlists.reset(); schedule(); }
        catch { /* A failed native edit does not invalidate confirmed state. */ }
      });
    }
    const endpoint = command?.likeEndpoint;
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
    if (mutations.some((item) => !item.target.closest?.('.ytmq-actions, .ytmq-message, .ytmq-picker')
      && (item.target.closest?.('ytmusic-player-queue, ytmusic-player-bar ytmusic-like-button-renderer')
        || [...item.addedNodes, ...item.removedNodes].some((node) => node.nodeType === 1
          && (node.matches?.('ytmusic-player-queue') || node.querySelector?.('ytmusic-player-queue')))))) {
      schedule();
    }
  });

  function applySetting() {
    // The storage bridge publishes normalized settings, but the shared DOM is
    // page-controlled. Read only the two preferences used here and validate them.
    let value;
    try { value = JSON.parse(document.documentElement.getAttribute('data-ytmq-settings') ?? '{}'); }
    catch { value = {}; }
    const candidate = value?.defaultPlaylist;
    const nextSettings = {
      defaultPlaylist: candidate && adapter.isPlaylistId(candidate.id)
        && typeof candidate.title === 'string' && candidate.title.trim() && candidate.title.length <= 500
        ? { id: candidate.id, title: candidate.title } : null,
      playlistModifier: ['shift', 'ctrl', 'alt'].includes(value?.playlistModifier) ? value.playlistModifier : 'shift',
    };
    if (nextSettings.defaultPlaylist?.id !== settings.defaultPlaylist?.id) {
      playlists.reset();
      closePicker(false);
    }
    settings = nextSettings;
    const next = document.documentElement.getAttribute('data-ytmq-enabled') === 'true';
    if (next === enabled) { schedule(); return; }
    enabled = next;
    if (enabled) {
      observer.observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['like-status', 'unplayable'] });
      // Polymer can replace a row's data without a DOM mutation. A bounded
      // refresh also catches late custom-element registration and metadata.
      poll = setInterval(() => { if (!document.hidden) schedule(); }, 1000);
      schedule();
    } else {
      closePicker(false);
      playlists.reset();
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
    attributes: true, attributeFilter: ['data-ytmq-enabled', 'data-ytmq-settings'],
  });
  document.addEventListener('yt-navigate-finish', schedule);
  document.addEventListener('yt-page-data-updated', schedule);
  document.addEventListener('visibilitychange', schedule);
  applySetting();
})();
