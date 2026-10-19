import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/settings-bridge.js', import.meta.url), 'utf8');

function setup() {
  let listener;
  let resolve;
  let reject;
  const attributes = new Map();
  vm.runInNewContext(source, {
    document: { documentElement: { setAttribute: (key, value) => attributes.set(key, value) } },
    console: { error() {} },
    chrome: { storage: {
      onChanged: { addListener: (callback) => { listener = callback; } },
      local: { get: () => new Promise((yes, no) => { resolve = yes; reject = no; }) },
    } },
  });
  return { attributes, change: (...args) => listener(...args),
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
