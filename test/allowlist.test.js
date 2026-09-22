'use strict';

const test = require('node:test');
const assert = require('node:assert');

const allowlist = require('../src/common/allowlist.js');

const { fakeStorage } = require('../test-support/storage.js');

/**
 * @param {unknown} [initial] The stored allowlist; omit for a fresh install.
 * @returns {import('../test-support/storage.js').FakeStorage}
 */
const memory = (initial) =>
  fakeStorage(initial === undefined ? {} : { [allowlist.STORAGE_KEY]: initial });

test.afterEach(() => {
  allowlist.setStorage(null);
});

test('a fresh install carries no repositories', async () => {
  const store = memory();
  allowlist.setStorage(store);
  assert.deepStrictEqual([...(await allowlist.load())], []);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
  assert.strictEqual(allowlist.isAllowed('git-utensils/Spoon-Knife'), false);
  assert.strictEqual(store.writes.length, 0, 'a read of an empty list wrote something');
  assert.strictEqual((await allowlist.add('containerd/containerd')).ok, true);
  assert.strictEqual(store.writes.length, 1, 'a write went unrecorded');
});

test('an unread list allows nothing', () => {
  allowlist.setStorage(memory(['containerd/containerd']));
  assert.strictEqual(allowlist.loaded(), false);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
});

test('a listed repository is allowed once the list is read', async () => {
  allowlist.setStorage(memory(['containerd/containerd']));
  await allowlist.load();
  assert.strictEqual(allowlist.loaded(), true);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), true);
  assert.strictEqual(allowlist.isAllowed('containerd/nerdctl'), false);
});

test('the comparison is case-insensitive in both directions', async () => {
  allowlist.setStorage(memory(['Git-Utensils/Spoon-Knife']));
  await allowlist.load();
  assert.deepStrictEqual([...allowlist.current()], ['git-utensils/spoon-knife']);
  assert.strictEqual(allowlist.isAllowed('git-utensils/spoon-knife'), true);
  assert.strictEqual(allowlist.isAllowed('Git-Utensils/Spoon-Knife'), true);
  assert.strictEqual(allowlist.isAllowed('GIT-UTENSILS/SPOON-KNIFE'), true);
});

test('a storage that fails to answer allows nothing', async () => {
  allowlist.setStorage({
    get: async () => {
      throw new Error('storage is unavailable');
    },
    set: async () => {},
  });
  assert.deepStrictEqual([...(await allowlist.load())], []);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
});

test('an environment with no storage allows nothing', async () => {
  allowlist.setStorage(null);
  assert.deepStrictEqual([...(await allowlist.load())], []);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
});

test('concurrent readers share one read', async () => {
  const store = memory(['containerd/containerd']);
  allowlist.setStorage(store);
  await Promise.all([allowlist.load(), allowlist.load(), allowlist.load()]);
  assert.strictEqual(store.reads.length, 1, `storage was read ${store.reads.length} times`);
});

test('a plausible repository is accepted and an implausible one is not', () => {
  for (const good of [
    'containerd/containerd',
    'git-utensils/Spoon-Knife',
    'a/b',
    'user1/repo.js',
    'org-name/repo_name',
    'org/repo-1.2.3',
    '  containerd/containerd  ',
  ]) {
    assert.strictEqual(allowlist.isValid(good), true, `rejected ${JSON.stringify(good)}`);
  }
  for (const bad of [
    '',
    '   ',
    'containerd',
    'containerd/',
    '/containerd',
    'containerd/containerd/extra',
    'owner/repo?query',
    'owner name/repo',
    'owner/repo name',
    '-owner/repo',
    'owner-/repo',
    'own--er/repo',
    'owner/.',
    'owner/..',
    'https://github.com/containerd/containerd',
    'owner/repo#fragment',
    'owner\\repo',
    `${'o'.repeat(40)}/repo`,
    `owner/${'r'.repeat(101)}`,
    null,
    undefined,
    42,
    ['owner/repo'],
  ]) {
    assert.strictEqual(allowlist.isValid(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('adding refuses what is not a repository and stores nothing for it', async () => {
  const store = memory();
  allowlist.setStorage(store);
  await allowlist.load();

  const malformed = await allowlist.add('not a repo');
  assert.strictEqual(malformed.ok, false);
  assert.strictEqual(malformed.reason, 'malformed');
  const empty = await allowlist.add('   ');
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'empty');

  assert.strictEqual(store.writes.length, 0, 'a refused entry was written');
  assert.deepStrictEqual([...allowlist.current()], []);

  assert.strictEqual((await allowlist.add('containerd/containerd')).ok, true);
  assert.strictEqual(store.writes.length, 1, 'an accepted entry went unrecorded');
});

test('adding normalizes case and refuses a repository already listed', async () => {
  const store = memory();
  allowlist.setStorage(store);
  await allowlist.load();

  const added = await allowlist.add('  Containerd/ContainerD  ');
  assert.strictEqual(added.ok, true);
  assert.strictEqual(added.entry, 'containerd/containerd');
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], ['containerd/containerd']);
  assert.strictEqual(allowlist.isAllowed('CONTAINERD/CONTAINERD'), true);

  const again = await allowlist.add('containerd/CONTAINERD');
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, 'duplicate');
  assert.strictEqual(store.writes.length, 1, `storage was written ${store.writes.length} times`);
});

test('removing takes a repository out of storage and closes the gate on it', async () => {
  const store = memory(['containerd/containerd', 'git-utensils/spoon-knife']);
  allowlist.setStorage(store);
  await allowlist.load();

  const left = await allowlist.remove('Containerd/Containerd');
  assert.deepStrictEqual([...left], ['git-utensils/spoon-knife']);
  assert.deepStrictEqual(store.entries[allowlist.STORAGE_KEY], ['git-utensils/spoon-knife']);
  assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
  assert.strictEqual(allowlist.isAllowed('git-utensils/spoon-knife'), true);
});

test('a stored value that is not a list of repositories is read as no list', async () => {
  for (const held of [null, 'containerd/containerd', 42, { 'containerd/containerd': true }]) {
    allowlist.setStorage(memory(held));
    assert.deepStrictEqual([...(await allowlist.load())], [], `read ${JSON.stringify(held)}`);
  }
});

test('stored entries that are not repositories are dropped and duplicates collapse', async () => {
  allowlist.setStorage(
    memory([
      'containerd/containerd',
      'not a repo',
      'CONTAINERD/CONTAINERD',
      '',
      null,
      'git-utensils/spoon-knife',
    ])
  );
  assert.deepStrictEqual(
    [...(await allowlist.load())],
    ['containerd/containerd', 'git-utensils/spoon-knife']
  );
});

test('a change to the list reaches whoever subscribed', async () => {
  allowlist.setStorage(memory(['containerd/containerd']));
  await allowlist.load();

  /** @type {string[][]} */
  const heard = [];
  const unsubscribe = allowlist.subscribe((entries) => {
    heard.push([...entries]);
  });

  await allowlist.remove('containerd/containerd');
  assert.deepStrictEqual(heard, [[]]);

  await allowlist.save([]);
  assert.deepStrictEqual(heard, [[]]);

  await allowlist.add('containerd/nerdctl');
  assert.deepStrictEqual(heard, [[], ['containerd/nerdctl']]);

  unsubscribe();
  await allowlist.remove('containerd/nerdctl');
  assert.deepStrictEqual(heard, [[], ['containerd/nerdctl']]);
});

test('the browser announcing a change takes the list without a read', async () => {
  /** @type {((changes: Record<string, { newValue?: unknown }>, area?: string) => void)[]} */
  const listeners = [];
  const store = memory(['containerd/containerd']);
  const global = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
  const before = global['browser'];
  global['browser'] = {
    storage: {
      local: store,
      onChanged: {
        /** @param {(changes: Record<string, { newValue?: unknown }>, area?: string) => void} fn */
        addListener: (fn) => listeners.push(fn),
      },
    },
  };
  try {
    // Passing null restores the browser's storage and change events.
    allowlist.setStorage(null);
    assert.strictEqual(allowlist.watch(), true);
    assert.strictEqual(allowlist.watch(), false, 'a second call subscribed again');
    await allowlist.load();
    assert.strictEqual(allowlist.isAllowed('containerd/containerd'), true);

    const readsBefore = store.reads.length;
    assert.ok(readsBefore > 0, 'the read the load did went unrecorded');
    for (const listener of listeners) {
      listener({ [allowlist.STORAGE_KEY]: { newValue: ['containerd/nerdctl'] } }, 'local');
    }
    assert.strictEqual(allowlist.isAllowed('containerd/containerd'), false);
    assert.strictEqual(allowlist.isAllowed('containerd/nerdctl'), true);
    assert.strictEqual(store.reads.length, readsBefore, 'the change was answered with a read');

    for (const listener of listeners) {
      listener({ [allowlist.STORAGE_KEY]: { newValue: [] } }, 'sync');
      listener({ members: { newValue: [] } }, 'local');
    }
    assert.strictEqual(allowlist.isAllowed('containerd/nerdctl'), true);
  } finally {
    if (before === undefined) delete global['browser'];
    else global['browser'] = before;
    allowlist.setStorage(null);
  }
});
