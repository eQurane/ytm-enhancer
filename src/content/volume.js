(() => {
  'use strict';
  const KEY = Symbol.for('ytmq.volume.v1');
  if (globalThis[KEY]) return;
  globalThis[KEY] = true;
  const adapter = globalThis[Symbol.for('ytmq.adapter.v1')];
  const selector = 'ytmusic-player-bar #volume-slider, ytmusic-player-bar #expand-volume-slider';
  const states = new Map();
  let enabled = false;
  let frame = null;
  let poll;

  function schedule() {
    if (!enabled || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; if (enabled) reconcile(); });
  }

  function refresh(state) {
    const value = adapter.readVolume(state.slider);
    const disabled = value === null || state.slider.getAttribute('aria-disabled') === 'true';
    state.input.disabled = disabled;
    if (!state.editing) state.input.value = value === null ? '' : String(value);
  }

  function commit(state) {
    const text = state.input.value.trim().replace(',', '.');
    state.editing = false;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text))) {
      adapter.setVolume(state.slider, Number(text));
    }
    refresh(state);
    schedule();
  }

  function create(slider) {
    const group = document.createElement('div');
    group.className = 'ytmq-volume';
    if (slider.hasAttribute('slot')) group.setAttribute('slot', slider.getAttribute('slot'));
    const track = document.createElement('div');
    track.className = 'ytmq-volume-track';
    const label = document.createElement('label');
    label.className = 'ytmq-volume-value';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Громкость в процентах, от 0 до 100');
    input.title = 'Громкость от 0 до 100%. Enter — применить, Escape — отменить';
    const suffix = document.createElement('span');
    suffix.textContent = '%';
    suffix.setAttribute('aria-hidden', 'true');
    label.append(input, suffix);
    const state = { slider, group, input, editing: false, step: slider.getAttribute('step'),
      propertyStep: slider.step, hadStep: 'step' in slider };
    states.set(slider, state);
    slider.before(group);
    track.append(slider);
    group.append(track, label);
    slider.closest('ytmusic-player-bar').classList.add('ytmq-volume-player');
    input.addEventListener('focus', () => { state.editing = true; });
    input.addEventListener('input', () => { state.editing = true; });
    input.addEventListener('blur', () => { if (state.editing) commit(state); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(state); }
      else if (event.key === 'Escape') { event.preventDefault(); state.editing = false; refresh(state); }
      // Keep typing and space/arrows from triggering the site's player shortcuts.
      event.stopPropagation();
    });
    for (const name of ['keyup', 'keypress', 'click', 'dblclick', 'tap']) {
      input.addEventListener(name, (event) => event.stopPropagation());
    }
    for (const name of ['click', 'dblclick', 'tap']) {
      group.addEventListener(name, (event) => event.stopPropagation());
    }
    refresh(state);
    return state;
  }

  function remove(state) {
    const { slider, group } = state;
    // The site may replace the slider inside our wrapper. Preserve that new
    // native element too, so the next reconciliation can enhance it.
    const remaining = group.querySelector('#volume-slider, #expand-volume-slider');
    if (remaining) group.replaceWith(remaining);
    else group.remove();
    if (state.hadStep) slider.step = state.propertyStep;
    if (state.step === null) slider.removeAttribute('step');
    else slider.setAttribute('step', state.step);
    const bar = slider.closest('ytmusic-player-bar');
    states.delete(slider);
    if (bar && ![...states.keys()].some((element) => element.closest('ytmusic-player-bar') === bar)) {
      bar.classList.remove('ytmq-volume-player');
    }
  }

  function reconcile() {
    for (const state of states.values()) {
      if (!state.slider.isConnected || !state.slider.matches(selector) || !state.group.contains(state.slider)) remove(state);
    }
    for (const slider of document.querySelectorAll(selector)) {
      const state = states.get(slider) ?? create(slider);
      // Attributes alone need not update an already-upgraded Polymer slider.
      // Native sliders otherwise round a wheel/input value of 0.5 back to 1.
      if ('step' in slider && slider.step !== 0.5) slider.step = 0.5;
      if (slider.getAttribute('step') !== '0.5') slider.setAttribute('step', '0.5');
      refresh(state);
    }
    const slider = states.keys().next().value;
    if (slider) adapter.syncVolume(slider);
  }

  function onWheel(event) {
    if (!enabled || event.ctrlKey) return; // Preserve browser pinch-to-zoom.
    const target = event.target?.closest?.('.ytmq-volume, .volume, #expand-volume');
    const bar = target?.closest('ytmusic-player-bar');
    if (!bar) return;
    const state = [...states.values()].find((item) => item.group === target
      || (item.slider.closest('ytmusic-player-bar') === bar
        && (target.id === 'expand-volume' ? item.slider.id === 'expand-volume-slider' : item.slider.id === 'volume-slider')));
    if (!state || state.input.disabled) return;
    // Capture both modern wheel and legacy mousewheel before the site's +10
    // handler. Cancelling wheel suppresses Chromium's compatibility mousewheel.
    const delta = event.type === 'wheel' ? event.deltaY : -event.wheelDelta;
    if (!Number.isFinite(delta) || delta === 0) return;
    const value = adapter.readVolume(state.slider);
    if (value === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    state.editing = false;
    // Stop at each boundary when entering a finer range from above or below.
    const next = delta < 0
      ? value < 5 ? Math.min(5, value + 0.5) : value < 10 ? Math.min(10, value + 1) : value + 5
      : value > 10 ? Math.max(10, value - 5) : value > 5 ? Math.max(5, value - 1) : value - 0.5;
    adapter.setVolume(state.slider, next);
    refresh(state);
    schedule();
  }

  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === 'attributes' ? record.target.matches?.(selector)
      : [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1
        && (node.matches?.('ytmusic-player-bar, #volume-slider, #expand-volume-slider')
          || node.querySelector?.('ytmusic-player-bar, #volume-slider, #expand-volume-slider'))))) schedule();
  });

  function applySetting() {
    const next = document.documentElement.getAttribute('data-ytmq-enabled') === 'true';
    if (next === enabled) { schedule(); return; }
    enabled = next;
    if (enabled) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['aria-valuenow', 'aria-disabled', 'value', 'step'] });
      for (const name of ['wheel', 'mousewheel']) document.addEventListener(name, onWheel, { capture: true, passive: false });
      for (const name of ['volumechange', 'loadedmetadata', 'playing']) document.addEventListener(name, schedule, true);
      // Catch custom-element upgrades and property-only site updates as well.
      poll = setInterval(() => { if (!document.hidden) schedule(); }, 1000);
      schedule();
    } else {
      observer.disconnect();
      clearInterval(poll);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      for (const name of ['wheel', 'mousewheel']) document.removeEventListener(name, onWheel, true);
      for (const name of ['volumechange', 'loadedmetadata', 'playing']) document.removeEventListener(name, schedule, true);
      adapter.restoreVolume(states.keys().next().value);
      for (const state of states.values()) remove(state);
    }
  }

  new MutationObserver(applySetting).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-ytmq-enabled'],
  });
  for (const name of ['yt-navigate-finish', 'yt-page-data-updated', 'visibilitychange']) document.addEventListener(name, schedule);
  applySetting();
})();
