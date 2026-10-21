import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const adapterSource = await readFile(new URL('../src/content/youtube-adapter.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/content/volume.js', import.meta.url), 'utf8');

// Minimal DOM/event propagation model: run the production controller and adapter
// against a native slider mock, including capture before the site's wheel handler.
function setup({ enabled = true, late = false, nativeAudio = false, exponential = true, remote = false } = {}) {
  let document;
  class InputEvent {
    constructor(type, options = {}) { Object.assign(this, { type, bubbles: false, ...options }); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
    stopImmediatePropagation() { this.stopped = true; this.immediate = true; }
  }
  class Element {
    constructor(tag) { this.tagName = tag; this.nodeType = 1; this.children = []; this.attributes = new Map(); this.listeners = []; this.value = ''; }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) { this.setAttribute('id', value); }
    get classList() {
      const values = () => new Set((this.className ?? '').split(/\s+/).filter(Boolean));
      return { add: (name) => { this.className = [...values().add(name)].join(' '); },
        remove: (name) => { const set = values(); set.delete(name); this.className = [...set].join(' '); } };
    }
    get isConnected() { return this === document || Boolean(this.parentNode?.isConnected); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    removeAttribute(key) { this.attributes.delete(key); }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentNode = this; } }
    before(node) {
      node.remove(); const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this), 0, node); node.parentNode = parent;
    }
    remove() { if (this.parentNode) { const nodes = this.parentNode.children; nodes.splice(nodes.indexOf(this), 1); this.parentNode = null; } }
    replaceWith(node) { if (this.parentNode) { this.before(node); this.remove(); } }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    matches(selector) {
      return selector.split(',').some((part) => {
        const bits = part.trim().split(/\s+/);
        const last = bits.pop();
        const own = last.startsWith('#') ? this.id === last.slice(1)
          : last.startsWith('.') ? (this.className ?? '').split(/\s+/).includes(last.slice(1))
            : this.tagName === last.split('.')[0] && last.split('.').slice(1).every((name) => (this.className ?? '').split(/\s+/).includes(name));
        return own && (!bits.length || Boolean(this.parentNode?.closest(bits.join(' '))));
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(type, fn, options) { this.listeners.push({ type, fn, capture: options === true || options?.capture === true }); }
    removeEventListener(type, fn, options) { this.listeners = this.listeners.filter((item) => item.type !== type || item.fn !== fn || item.capture !== (options === true)); }
    dispatchEvent(event) {
      event.target = this;
      const path = []; for (let node = this; node; node = node.parentNode) path.push(node);
      const call = (node, capture) => {
        for (const item of node.listeners.filter((item) => item.type === event.type && item.capture === capture)) {
          item.fn(event); if (event.immediate) break;
        }
      };
      for (const node of [...path].reverse()) { call(node, true); if (event.stopped) return !event.defaultPrevented; }
      for (const node of path) { call(node, false); if (event.stopped || !event.bubbles) break; }
      return !event.defaultPrevented;
    }
  }
  document = new Element('document');
  document.nodeType = 9;
  document.createElement = (name) => new Element(name);
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.append(document.documentElement);
  document.documentElement.append(document.body);
  document.documentElement.setAttribute('data-ytmq-enabled', String(enabled));
  const observers = [];
  const frames = new Map();
  const intervals = new Map();
  let sequence = 0;
  const context = vm.createContext({ document, Event: InputEvent,
    ytcfg: { get: (key) => key === 'EXPERIMENT_FLAGS'
      ? { music_web_enable_exponential_volume_control: exponential } : undefined },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    },
    requestAnimationFrame: (callback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setInterval: (callback) => { intervals.set(++sequence, callback); return sequence; },
    clearInterval: (id) => intervals.delete(id),
  });
  const bar = new Element('ytmusic-player-bar');
  const controls = new Element('div');
  const icon = new Element('button'); icon.className = 'volume';
  controls.append(icon); bar.append(controls); document.body.append(bar);
  let volume = 10, muted = false, changes = 0, nativeWheels = 0;
  let media, rawVolume = 0, normalization = 0.7, apiCalls = 0;
  const outputFor = (level) => exponential ? Math.max(0, 2 ** (0.03917 * level + 2.82823) - 7.13431) : level;
  if (nativeAudio) {
    const player = new Element('ytmusic-player');
    media = new Element('video'); media.className = 'html5-main-video';
    let actual = 0;
    Object.defineProperty(media, 'volume', { get: () => actual, set: (value) => {
      if (actual === value) return;
      actual = value;
      media.dispatchEvent(new InputEvent('volumechange'));
    } });
    player.append(media); document.body.append(player);
    bar.playerApi = { isReady: () => true, isMuted: () => muted,
      getPresentingPlayerType: () => remote ? 2 : 1,
      getVolume: () => rawVolume,
      setVolume: (value) => { apiCalls += 1; rawVolume = Math.floor(value); media.volume = rawVolume / 100 * normalization; },
    };
  }
  const sync = () => {
    for (const slider of bar.querySelectorAll('tp-yt-paper-slider')) slider.value = muted ? 0 : volume;
    if (media) { bar.playerApi.setVolume(outputFor(volume)); media.muted = muted; }
  };
  function addSlider(id, step) {
    const slider = new Element('tp-yt-paper-slider'); slider.id = id;
    Object.defineProperty(slider, 'step', { get: () => Number(slider.getAttribute('step')), set: (value) => slider.setAttribute('step', value) });
    Object.defineProperty(slider, 'value', { get: () => Number(slider.getAttribute('value')), set: (value) => {
      // Like Polymer's range behavior, the native mock snaps programmatic
      // values to its step too: a step of 1 must not silently eat 0.5%.
      slider.setAttribute('value', Math.max(0, Math.min(100, Math.round(value / slider.step) * slider.step)));
      slider.setAttribute('aria-valuenow', slider.getAttribute('value'));
    } });
    slider.step = step; slider.value = muted ? 0 : volume;
    slider.addEventListener('wheel', () => { nativeWheels += 1; });
    controls.append(slider);
    return slider;
  }
  bar.addEventListener('change', (event) => {
    volume = event.target.value; if (volume > 0) muted = false; changes += 1; sync();
  });
  if (!late) { addSlider('volume-slider', 1); addSlider('expand-volume-slider', 5); }
  vm.runInContext(adapterSource + source, context);
  const event = (element, type, options = {}) => {
    const value = new InputEvent(type, { bubbles: true, ...options }); element.dispatchEvent(value); return value;
  };
  const flush = () => { for (const callback of intervals.values()) callback(); for (let i = 0; frames.size && i < 10; i++) {
    const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback());
  } assert.equal(frames.size, 0, 'controller should settle'); };
  flush();
  const setting = (next) => {
    document.documentElement.setAttribute('data-ytmq-enabled', String(next));
    observers.filter((item) => item.target === document.documentElement).forEach((item) => item.callback([])); flush();
  };
  return { document, bar, controls, icon, event, flush, setting, addSlider, context,
    slider: () => bar.querySelector('#volume-slider'),
    input: () => bar.querySelector('.ytmq-volume-value').querySelector('input'),
    external: (value, mute = false) => { volume = value; muted = mute; sync(); flush(); },
    values: () => ({ volume, muted, changes, nativeWheels }),
    audio: () => ({ actual: media.volume, rawVolume, apiCalls, muted: media.muted }),
    newTrack: (factor) => { normalization = factor; media.volume = rawVolume / 100 * factor; event(media, 'loadedmetadata'); flush(); },
    adapter: vm.runInContext("globalThis[Symbol.for('ytmq.adapter.v1')]", context),
  };
}

test('enhances both sliders with fields, and restores original steps and DOM on disable', () => {
  const s = setup();
  assert.equal(s.bar.querySelectorAll('.ytmq-volume').length, 2);
  assert.equal(s.input().value, '10');
  assert.equal(s.slider().step, 0.5);
  assert.equal(s.bar.querySelector('#expand-volume-slider').step, 0.5);
  s.setting(false);
  assert.equal(s.bar.querySelectorAll('.ytmq-volume').length, 0);
  assert.equal(s.slider().parentNode, s.controls);
  assert.equal(s.bar.querySelector('#expand-volume-slider').step, 5);
  const wheel = s.event(s.slider(), 'wheel', { deltaY: -100 });
  assert.equal(wheel.defaultPrevented, undefined);
  assert.equal(s.values().nativeWheels, 1);
  s.setting(true);
  assert.equal(s.bar.querySelectorAll('.ytmq-volume').length, 2);
});

test('wheel on slider, icon, field and expanded slider changes by five once and clamps boundaries', () => {
  const s = setup();
  for (const target of [s.slider(), s.icon, s.input(), s.bar.querySelector('#expand-volume-slider')]) {
    const wheel = s.event(target, 'wheel', { deltaY: -120 });
    assert.equal(wheel.defaultPrevented, true); assert.equal(wheel.immediate, true);
  }
  assert.deepEqual(s.values(), { volume: 30, muted: false, changes: 4, nativeWheels: 0 });
  s.event(s.slider(), 'mousewheel', { wheelDelta: -120 }); assert.equal(s.values().volume, 25);
  s.external(98); s.event(s.icon, 'wheel', { deltaY: -1 }); assert.equal(s.values().volume, 100);
  s.external(0); s.event(s.icon, 'wheel', { deltaY: 1 }); assert.equal(s.values().volume, 0);
  const before = s.values().changes;
  s.event(s.icon, 'wheel', { deltaY: 0 });
  s.event(s.icon, 'wheel', { deltaY: -1, ctrlKey: true });
  assert.equal(s.values().changes, before);
});

test('wheel uses half-point steps through five, one-point steps through ten, and stops at range boundaries', () => {
  const s = setup();
  for (const type of ['wheel', 'mousewheel']) {
    const scroll = (up) => s.event(s.slider(), type, type === 'wheel'
      ? { deltaY: up ? -100 : 100 } : { wheelDelta: up ? 120 : -120 });
    for (let value = 0; value < 5; value += 0.5) {
      s.external(value); scroll(true);
      assert.equal(s.values().volume, value + 0.5, `${type}: increase ${value}`);
    }
    for (let value = 0.5; value <= 5; value += 0.5) {
      s.external(value); scroll(false);
      assert.equal(s.values().volume, value - 0.5, `${type}: decrease ${value}`);
    }
    for (let value = 5; value < 10; value++) {
      s.external(value); scroll(true);
      assert.equal(s.values().volume, value + 1, `${type}: increase ${value}`);
    }
    for (let value = 6; value <= 10; value++) {
      s.external(value); scroll(false);
      assert.equal(s.values().volume, value - 1, `${type}: decrease ${value}`);
    }
    for (const [value, up, expected] of [[10, true, 15], [11, false, 10], [12, false, 10],
      [14, false, 10], [15, false, 10], [16, false, 11], [20, true, 25], [0, false, 0],
      [5, true, 6], [5, false, 4.5], [5.5, false, 5], [9.5, true, 10], [10.5, false, 10]]) {
      s.external(value); scroll(up);
      assert.equal(s.values().volume, expected, `${type}: ${value} ${up ? 'up' : 'down'}`);
    }
    s.external(37, true); scroll(true);
    assert.equal(s.values().volume, 0.5);
    assert.equal(s.values().muted, false);
  }
});

test('input commits on Enter or blur, clamps integer values and cancels with Escape', () => {
  const s = setup(); const input = s.input();
  const type = (text) => { s.event(input, 'focus'); input.value = text; s.event(input, 'input'); };
  type('42'); s.event(input, 'keydown', { key: 'Enter' }); assert.equal(s.values().volume, 42);
  s.event(input, 'blur'); assert.equal(s.values().changes, 1, 'Enter followed by blur must not commit twice');
  type('150'); s.event(input, 'blur'); assert.equal(s.values().volume, 100); assert.equal(input.value, '100');
  type('-10'); s.event(input, 'keydown', { key: 'Enter' }); assert.equal(s.values().volume, 0);
  for (const text of ['', 'abc', '1..5', '1,2,3', '1e2', 'Infinity']) {
    type(text); s.event(input, 'blur'); assert.equal(s.values().volume, 0); assert.equal(input.value, '0');
  }
  type('73'); s.event(input, 'keydown', { key: 'Escape' }); s.event(input, 'blur');
  assert.equal(input.value, '0'); assert.equal(s.values().volume, 0);
});

test('fractional input with dot or comma and external half-points survive native slider snapping', () => {
  const s = setup(); const input = s.input();
  assert.equal(input.inputMode, 'decimal');
  for (const [text, expected] of [['0.5', 0.5], ['4,5', 4.5], ['10.5', 10.5], ['2.7', 2.5], ['99,5', 99.5]]) {
    input.value = text; s.event(input, 'input'); s.event(input, 'keydown', { key: 'Enter' }); s.flush();
    assert.equal(s.values().volume, expected);
    for (const slider of s.bar.querySelectorAll('tp-yt-paper-slider')) assert.equal(slider.value, expected);
    for (const field of s.bar.querySelectorAll('input')) assert.equal(field.value, String(expected));
  }
  s.external(0.5);
  assert.equal(input.value, '0.5');
  s.event(s.icon, 'wheel', { deltaY: -1 });
  assert.equal(s.values().volume, 1);
  s.event(s.bar.querySelector('#expand-volume-slider'), 'wheel', { deltaY: 1 }); s.flush();
  assert.equal(s.values().volume, 0.5);
  assert.equal(input.value, '0.5');
});

test('external changes and mute synchronize both fields without overwriting a draft', () => {
  const s = setup(); const input = s.input();
  s.external(37); assert.equal(input.value, '37');
  s.event(input, 'focus'); input.value = '68'; s.event(input, 'input');
  s.external(22); assert.equal(input.value, '68');
  s.event(input, 'keydown', { key: 'Escape' }); assert.equal(input.value, '22');
  s.external(37, true);
  assert.equal(input.value, '0');
  input.value = '21'; s.event(input, 'input'); s.event(input, 'keydown', { key: 'Enter' });
  s.flush();
  assert.equal(s.values().muted, false);
  for (const field of s.bar.querySelectorAll('input')) assert.equal(field.value, '21');
});

test('handles late sliders, replacement inside an existing wrapper and reinjection without duplicates', () => {
  const s = setup({ late: true });
  assert.equal(s.bar.querySelectorAll('.ytmq-volume').length, 0);
  s.addSlider('volume-slider', 1); s.flush();
  const previous = s.slider(); const replacement = s.addSlider('volume-slider', 1);
  previous.replaceWith(replacement); s.flush();
  assert.equal(s.slider(), replacement); assert.equal(replacement.isConnected, true);
  assert.equal(s.bar.querySelectorAll('.ytmq-volume').length, 1);
  vm.runInContext(source, s.context); s.flush();
  assert.equal(s.bar.querySelectorAll('.ytmq-volume').length, 1);
  s.bar.remove(); s.flush();
  assert.equal(s.bar.querySelectorAll('.ytmq-volume').length, 0);
});

test('disabled or invalid native state cannot change volume; unupgraded sliders are not shadowed', () => {
  const s = setup();
  s.slider().setAttribute('aria-disabled', 'true'); s.flush();
  assert.equal(s.input().disabled, true);
  s.event(s.icon, 'wheel', { deltaY: -1 }); assert.equal(s.values().changes, 0);
  s.slider().removeAttribute('aria-disabled'); s.slider().setAttribute('aria-valuenow', 'broken'); s.flush();
  assert.equal(s.input().disabled, true);
  const placeholder = s.document.createElement('tp-yt-paper-slider');
  delete placeholder.value; s.controls.append(placeholder);
  assert.equal(s.adapter.setVolume(placeholder, 50), false);
  assert.equal('value' in placeholder, false);
  for (const value of [NaN, Infinity, '50']) assert.equal(s.adapter.setVolume(s.slider(), value), false);
  s.slider().remove(); assert.equal(s.adapter.setVolume(s.slider(), 50), false);
});

test('editing keys and clicks on the percent label do not activate player shortcuts or toggle its page', () => {
  const s = setup();
  let shortcuts = 0, clicks = 0;
  s.bar.addEventListener('keydown', () => { shortcuts += 1; });
  s.bar.addEventListener('click', () => { clicks += 1; });
  for (const key of [' ', 'm', 'ArrowLeft', 'Enter', 'Escape']) s.event(s.input(), 'keydown', { key });
  s.event(s.bar.querySelector('.ytmq-volume-value').querySelector('span'), 'click');
  assert.equal(shortcuts, 0);
  assert.equal(clicks, 0);
});

test('sub-five-percent levels produce real nonzero audio after the native exponential curve and integer truncation', () => {
  const s = setup({ nativeAudio: true });
  for (let value = 0.5; value < 5; value += 0.5) {
    s.adapter.setVolume(s.slider(), value); s.flush();
    const expected = (2 ** (0.03917 * value + 2.82823) - 7.13431) / 100 * 0.7;
    assert.ok(Math.abs(s.audio().actual - expected) < 1e-12, `actual audio at ${value}%`);
    assert.ok(s.audio().actual > 0);
    assert.equal(s.audio().muted, false);
    assert.equal(s.input().value, String(value));
  }
  const calls = s.audio().apiCalls;
  s.flush(); s.flush();
  assert.equal(s.audio().apiCalls, calls, 'polling must not briefly raise the reference volume each time');
  s.adapter.setVolume(s.slider(), 0); s.flush();
  assert.equal(s.audio().actual, 0);
});

test('quiet audio follows external changes and track normalization, and restores native output when disabled', () => {
  const s = setup({ nativeAudio: true });
  s.external(2.5);
  const before = s.audio().actual;
  s.newTrack(0.35);
  assert.ok(Math.abs(s.audio().actual - before / 2) < 1e-12);
  s.setting(false);
  assert.equal(s.audio().actual, 0, 'native API floors this quiet setting back to zero');
  s.setting(true);
  assert.ok(s.audio().actual > 0);
  s.external(2.5, true);
  assert.equal(s.audio().muted, true);
  assert.equal(s.audio().actual, 0);
  s.external(10);
  assert.equal(s.audio().rawVolume, 2);
  assert.ok(Math.abs(s.audio().actual - 0.007) < 1e-12);
});

test('fractional audio also works without the exponential experiment and does not override casting', () => {
  const local = setup({ nativeAudio: true, exponential: false });
  local.adapter.setVolume(local.slider(), 0.5); local.flush();
  assert.ok(Math.abs(local.audio().actual - 0.0035) < 1e-12);
  const cast = setup({ nativeAudio: true, remote: true });
  const before = cast.audio().apiCalls;
  cast.adapter.setVolume(cast.slider(), 0.5); cast.flush();
  assert.equal(cast.audio().rawVolume, 0);
  assert.equal(cast.audio().apiCalls, before + 1, 'only the native command should be sent while casting');
});
