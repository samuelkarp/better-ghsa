'use strict';

const test = require('node:test');
const assert = require('node:assert');

const diag = require('../src/common/diag.js');

const { fakeStorage } = require('../test-support/storage.js');

/**
 * Run the work with BGHSA_DIAG unset and console.info recorded.
 *
 * @param {() => Promise<void>} work
 * @returns {Promise<unknown[][]>} the arguments of each console.info call.
 */
async function printed(work) {
  const env = process.env['BGHSA_DIAG'];
  const info = console.info;
  /** @type {unknown[][]} */
  const lines = [];
  delete process.env['BGHSA_DIAG'];
  console.info = (...args) => {
    lines.push(args);
  };
  try {
    await work();
  } finally {
    console.info = info;
    if (env !== undefined) process.env['BGHSA_DIAG'] = env;
    diag.setStorage(null);
  }
  return lines;
}

test('a fresh install prints no diagnostic line', async () => {
  let asked = false;
  const lines = await printed(async () => {
    diag.setStorage(fakeStorage());
    assert.strictEqual(await diag.load(), false);
    diag.log('queue add given=1');
    diag.log(() => {
      asked = true;
      return 'queue add given=2';
    });
    diag.caught('cache discard', new Error('refused'));
  });
  assert.deepStrictEqual(lines, []);
  assert.strictEqual(asked, false, 'the text of a line nobody sees was built');
});

test('the lines print while the setting is on and stop when it goes off', async () => {
  const lines = await printed(async () => {
    diag.setStorage(fakeStorage());
    await diag.save(true);
    diag.log('queue add given=1');
    diag.log(() => 'queue add given=2');
    diag.caught('cache discard', 'refused');
    await diag.save(false);
    diag.log('queue add given=3');
  });
  assert.deepStrictEqual(lines, [
    ['[better-ghsa] diag queue add given=1'],
    ['[better-ghsa] diag queue add given=2'],
    ['[better-ghsa] diag caught', 'cache discard', 'refused', undefined],
  ]);
});

test('the setting is stored under its own key and read back', async () => {
  const store = fakeStorage();
  await printed(async () => {
    diag.setStorage(store);
    await diag.save(true);
    assert.deepStrictEqual(store.entries, { [diag.STORAGE_KEY]: true });

    diag.setStorage(store);
    assert.strictEqual(diag.enabled(), false, 'the setting was on before it was read');
    assert.strictEqual(await diag.load(), true);
    assert.strictEqual(diag.enabled(), true);
  });
});

test('a rejection passed through for printing is unhandled exactly when the original was', async () => {
  // The runner fails a test on any unhandled rejection; this test counts them.
  const runner = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  /** @type {unknown[]} */
  const unhandled = [];
  process.on('unhandledRejection', (reason) => {
    unhandled.push(reason);
  });
  try {
    for (const on of [false, true]) {
      await printed(async () => {
        diag.setStorage(fakeStorage());
        await diag.save(on);
        for (const awaited of [false, true]) {
          unhandled.length = 0;
          const broken = new Error('refused');
          const kept = diag.rejection('queue read', Promise.reject(broken));
          if (awaited) await assert.rejects(kept, broken);
          await new Promise((resolve) => setTimeout(resolve, 10));
          assert.deepStrictEqual(
            unhandled,
            awaited ? [] : [broken],
            `setting ${on ? 'on' : 'off'}, ${awaited ? 'awaited' : 'not awaited'}`
          );
        }
      });
    }
  } finally {
    process.removeAllListeners('unhandledRejection');
    for (const listener of runner) process.on('unhandledRejection', listener);
  }
});
