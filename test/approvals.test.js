'use strict';

const test = require('node:test');
const assert = require('node:assert');

const approvals = require('../src/common/approvals.js');

const { fakeStorage } = require('../test-support/storage.js');

test.afterEach(() => {
  approvals.setStorage(null);
});

test('a repository without a setting needs two approvals', async () => {
  approvals.setStorage(fakeStorage());
  await approvals.load();
  assert.strictEqual(approvals.requiredFor('containerd/containerd'), 2);
});

test('a stored count is read under any spelling of its repository, and junk is not', async () => {
  approvals.setStorage(
    fakeStorage({
      [approvals.STORAGE_KEY]: {
        'Containerd/Containerd': 0,
        'containerd/nerdctl': 1.5,
        'containerd/ttrpc': -1,
        'containerd/runwasi': '3',
        'not a repository': 4,
      },
    })
  );
  await approvals.load();
  assert.strictEqual(approvals.requiredFor('containerd/CONTAINERD'), 0);
  for (const repository of ['containerd/nerdctl', 'containerd/ttrpc', 'containerd/runwasi']) {
    assert.strictEqual(approvals.requiredFor(repository), 2, `${repository} kept a bad count`);
  }
});

test('a whole number is saved beside the others, and anything else is refused', async () => {
  const store = fakeStorage({ [approvals.STORAGE_KEY]: { 'containerd/nerdctl': 1 } });
  approvals.setStorage(store);
  await approvals.load();
  /** @type {Readonly<Record<string, number>>[]} */
  const heard = [];
  const unsubscribe = approvals.subscribe((held) => heard.push(held));
  try {
    assert.strictEqual(await approvals.save('Containerd/Containerd', 3), true);
    assert.deepStrictEqual(store.entries[approvals.STORAGE_KEY], {
      'containerd/nerdctl': 1,
      'containerd/containerd': 3,
    });
    assert.strictEqual(approvals.requiredFor('containerd/containerd'), 3);
    assert.strictEqual(heard.length, 1, 'the change went unannounced');

    for (const count of [-1, 1.5, '2', NaN, null]) {
      assert.strictEqual(await approvals.save('containerd/containerd', count), false);
    }
    assert.strictEqual(await approvals.save('containerd', 1), false);
    assert.strictEqual(store.writes.length, 1, 'a refused count was stored');
  } finally {
    unsubscribe();
  }
});

test('a count changed in another tab reaches this page without a read', async () => {
  /** @type {((changes: Record<string, { newValue?: unknown }>, area?: string) => void)[]} */
  const listeners = [];
  const store = fakeStorage();
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
    approvals.setStorage(null);
    approvals.watch();
    await approvals.load();
    const reads = store.reads.length;
    for (const listener of listeners) {
      listener({ [approvals.STORAGE_KEY]: { newValue: { 'containerd/containerd': 1 } } }, 'local');
    }
    assert.strictEqual(approvals.requiredFor('containerd/containerd'), 1);
    assert.strictEqual(store.reads.length, reads, 'the change was answered with a read');
  } finally {
    if (before === undefined) delete global['browser'];
    else global['browser'] = before;
  }
});
