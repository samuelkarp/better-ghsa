'use strict';

const test = require('node:test');
const assert = require('node:assert');

const storage = require('../src/common/storage.js');
const allowlist = require('../src/common/allowlist.js');
const members = require('../src/common/members.js');
const branches = require('../src/common/branches.js');
const cache = require('../src/common/cache.js');

/**
 * @param {readonly string[]} methods
 * @returns {Record<string, unknown>}
 */
function localWith(methods) {
  /** @type {Record<string, unknown>} */
  const area = {};
  for (const method of methods) area[method] = async () => ({});
  return area;
}

/**
 * Install browser and chrome globals for the callback and delete them afterward.
 *
 * @param {{ browser?: unknown, chrome?: unknown }} globals
 * @param {() => void} body
 * @returns {void}
 */
function withGlobals(globals, body) {
  const held = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
  try {
    if (globals.browser !== undefined) held['browser'] = globals.browser;
    if (globals.chrome !== undefined) held['chrome'] = globals.chrome;
    body();
  } finally {
    delete held['browser'];
    delete held['chrome'];
  }
}

/**
 * @returns {Record<string, unknown>}
 */
function storesRead() {
  return {
    allowlist: allowlist.storageOf(),
    members: members.storageOf(),
    branches: branches.storageOf(),
    cache: cache.storageOf(),
  };
}

test('outside a browser there is no store, and every caller says so', () => {
  assert.strictEqual(storage.local(), null);
  assert.strictEqual(storage.api(), undefined);
  assert.deepStrictEqual(storesRead(), {
    allowlist: null,
    members: null,
    branches: null,
    cache: null,
  });
});

test('a name whose store cannot answer is passed over for one that can', () => {
  const working = localWith(['get', 'set', 'remove']);
  withGlobals(
    { browser: { storage: { local: localWith(['set']) } }, chrome: { storage: { local: working } } },
    () => {
      assert.strictEqual(storage.local(), working);
      assert.deepStrictEqual(storesRead(), {
        allowlist: working,
        members: working,
        branches: working,
        cache: working,
      });
    }
  );
});

test('the cache is the caller that evicts, and asks for a store that can', () => {
  const partial = localWith(['get', 'set']);
  const whole = localWith(['get', 'set', 'remove']);
  withGlobals({ browser: { storage: { local: partial } }, chrome: { storage: { local: whole } } }, () => {
    assert.strictEqual(storage.local(), partial);
    assert.strictEqual(storage.local(['get', 'set', 'remove']), whole);
    assert.deepStrictEqual(storesRead(), {
      allowlist: partial,
      members: partial,
      branches: partial,
      cache: whole,
    });
  });
});

test('the list is watched on the API the list is read from', () => {
  /** @type {string[]} */
  const subscribed = [];
  const shim = {
    storage: { local: localWith(['set']), onChanged: { addListener: () => subscribed.push('browser') } },
  };
  const real = {
    storage: {
      local: localWith(['get', 'set']),
      onChanged: { addListener: () => subscribed.push('chrome') },
    },
  };
  withGlobals({ browser: shim, chrome: real }, () => {
    assert.strictEqual(allowlist.watch(), true, 'nothing subscribed to the change events');
    assert.deepStrictEqual(subscribed, ['chrome']);
  });
});

test('a store put in place of the browser\'s is what that caller reads', () => {
  const stand = { get: async () => ({}), set: async () => {} };
  withGlobals({ chrome: { storage: { local: localWith(['get', 'set', 'remove']) } } }, () => {
    members.setStorage(stand);
    try {
      assert.strictEqual(members.storageOf(), stand);
      assert.notStrictEqual(branches.storageOf(), stand, 'one caller\'s stand-in reached another');
    } finally {
      members.setStorage(null);
    }
  });
});
