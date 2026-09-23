'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const members = require('../src/common/members.js');
const panel = require('../src/detail/panel.js');

const { fakeStorage } = require('../test-support/storage.js');

/** @typedef {import('../test-support/storage.js').FakeStorage} Fake */

/**
 * @param {unknown} [held] The initial stored member map.
 * @returns {Fake}
 */
const memberStorage = (held) =>
  fakeStorage(held === undefined ? {} : { [members.MEMBERS_KEY]: held });

/**
 * @param {string} name
 * @returns {Document}
 */
function fixture(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

const UTENSILS = { owner: 'git-utensils' };

const CONTAINERD = { owner: 'containerd' };
/**
 * @param {Fake} storage
 * @param {string} key The organization to read out of the entry.
 * @returns {string[]} the logins the entry holds for that organization.
 */
function stored(storage, key) {
  const value = storage.entries[members.MEMBERS_KEY];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const logins = /** @type {Record<string, unknown>} */ (value)[key];
  return Array.isArray(logins) ? logins.map((login) => String(login)) : [];
}

/** @returns {void} */
function forget() {
  members.clear();
  members.setStorage(null);
}

test('a login is held once, spelled as it was first read', () => {
  forget();
  assert.strictEqual(members.remember(UTENSILS, ['samuelkarp']), true);
  assert.strictEqual(
    members.remember(UTENSILS, ['SamuelKarp']),
    false,
    'one account was held twice'
  );
  assert.deepStrictEqual(members.known(UTENSILS), ['samuelkarp']);
  assert.strictEqual(members.isKnown(UTENSILS, 'SAMUELKARP'), true);
  assert.strictEqual(members.isKnown(UTENSILS, 'prakleumas'), false);
});

test('a member of one organization is not a member of another', () => {
  forget();
  members.remember(CONTAINERD, ['dmcgowan']);
  assert.deepStrictEqual(members.known(CONTAINERD), ['dmcgowan']);
  assert.deepStrictEqual(members.known(UTENSILS), [], 'the other organization holds the login');
  assert.strictEqual(members.isKnown(UTENSILS, 'dmcgowan'), false);
  assert.strictEqual(members.isKnown({ owner: 'CONTAINERD' }, 'dmcgowan'), true);
});

test('a page that names no organization holds nothing and offers nothing', () => {
  forget();
  assert.strictEqual(members.remember(null, ['dmcgowan']), false);
  assert.strictEqual(members.remember({ owner: '  ' }, ['dmcgowan']), false);
  assert.deepStrictEqual(members.known(null), []);
  assert.strictEqual(members.isKnown(null, 'dmcgowan'), false);
});

test('a login with nothing in it is not a member', () => {
  forget();
  assert.strictEqual(members.remember(UTENSILS, ['', '  ', null, undefined]), false);
  assert.deepStrictEqual(members.known(UTENSILS), []);
});

test('the logins this session read are written to storage', async () => {
  forget();
  const storage = memberStorage();
  members.setStorage(storage);
  members.remember(UTENSILS, ['samuelkarp', 'dmcgowan']);

  assert.strictEqual(await members.sync(), false, 'storage held a login this session did not');
  assert.deepStrictEqual(stored(storage, 'git-utensils'), ['samuelkarp', 'dmcgowan']);
});

test('the entry accumulates the logins of every session that wrote it', async () => {
  forget();
  const storage = memberStorage({ 'git-utensils': ['dmcgowan'] });
  members.setStorage(storage);
  members.remember(UTENSILS, ['samuelkarp']);

  assert.strictEqual(await members.sync(), true, 'a login storage held did not arrive');
  assert.deepStrictEqual(members.known(UTENSILS), ['samuelkarp', 'dmcgowan']);
  assert.deepStrictEqual(stored(storage, 'git-utensils'), ['samuelkarp', 'dmcgowan']);
});

test('a session that adds nothing leaves the entry as it stands', async () => {
  forget();
  const storage = memberStorage({ 'git-utensils': ['dmcgowan', 'samuelkarp'] });
  members.setStorage(storage);
  members.remember(UTENSILS, ['SAMUELKARP']);

  assert.strictEqual(await members.sync(), true);
  assert.strictEqual(storage.writes.length, 0, 'the entry was written with nothing new in it');
  assert.deepStrictEqual(members.known(UTENSILS), ['SAMUELKARP', 'dmcgowan']);

  members.remember(UTENSILS, ['estesp']);
  assert.strictEqual(await members.sync(), false, 'storage held a login this session did not');
  assert.strictEqual(storage.writes.length, 1, 'a write went unrecorded');
  assert.ok(
    stored(storage, 'git-utensils').includes('estesp'),
    'the login the session added is not in the entry'
  );
});

test('an entry holding something other than logins is read as empty', async () => {
  forget();
  const storage = memberStorage({ 'git-utensils': { samuelkarp: true } });
  members.setStorage(storage);
  members.remember(UTENSILS, ['samuelkarp']);

  assert.strictEqual(await members.sync(), false);
  assert.deepStrictEqual(members.known(UTENSILS), ['samuelkarp']);
  assert.deepStrictEqual(
    stored(storage, 'git-utensils'),
    ['samuelkarp'],
    'the entry was left unusable'
  );
});

test('an entry from before membership was per organization is dropped', async () => {
  forget();
  const storage = memberStorage(['dmcgowan', 'samuelkarp']);
  members.setStorage(storage);
  members.remember(CONTAINERD, ['dmcgowan']);

  assert.strictEqual(await members.sync(), false, 'the global entry taught this session a login');
  assert.deepStrictEqual(members.known(CONTAINERD), ['dmcgowan']);
  assert.deepStrictEqual(members.known(UTENSILS), []);
  assert.deepStrictEqual(
    stored(storage, 'containerd'),
    ['dmcgowan'],
    'the entry was not written in the per-organization shape'
  );
});

test('storage that fails leaves this session holding what it read', async () => {
  forget();
  members.remember(UTENSILS, ['samuelkarp']);
  const broken = {
    /** @returns {Promise<Record<string, unknown>>} */
    get: async () => {
      throw new Error('storage is unavailable');
    },
    /** @returns {Promise<void>} */
    set: async () => {
      throw new Error('storage is unavailable');
    },
  };
  members.setStorage(broken);

  assert.strictEqual(await members.sync(), false);
  assert.deepStrictEqual(members.known(UTENSILS), ['samuelkarp']);
});

test('a set that cannot be stored is still held for this page', async () => {
  forget();
  const storage = memberStorage({ 'git-utensils': ['dmcgowan'] });
  members.setStorage({
    get: storage.get,
    /** @returns {Promise<void>} */
    set: async () => {
      throw new Error('the quota is full');
    },
  });
  members.remember(UTENSILS, ['samuelkarp']);

  assert.strictEqual(await members.sync(), true);
  assert.deepStrictEqual(members.known(UTENSILS), ['samuelkarp', 'dmcgowan']);
});

test('a page outside a browser stores nothing and reads nothing', async () => {
  forget();
  members.remember(UTENSILS, ['samuelkarp']);
  assert.strictEqual(members.storageOf(), null, 'this environment offers an extension storage');
  assert.strictEqual(await members.sync(), false);
  assert.deepStrictEqual(members.known(UTENSILS), ['samuelkarp']);
});

test('a render pass holds the members the page shows and stores them', async () => {
  forget();
  const storage = memberStorage();
  members.setStorage(storage);

  const placed = await panel.render(fixture('triage-thread.html'));
  assert.ok(placed !== null, 'the fixture offered no anchor');
  assert.deepStrictEqual(
    members.known(UTENSILS),
    ['samuelkarp'],
    'the pass did not hold the page members before it drew'
  );
  assert.deepStrictEqual(
    members.known(CONTAINERD),
    [],
    'the pass held the page members against another organization'
  );

  // Member storage completes after the render pass returns.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(
    stored(storage, 'git-utensils'),
    ['samuelkarp'],
    'the pass stored no member'
  );
  forget();
});
