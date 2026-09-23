'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML } = require('linkedom');

const dom = require('../src/common/dom.js');

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The document exposes MutationObserver through defaultView.
 *
 * @returns {{ doc: Document, owned: Element }}
 */
function page() {
  const { document } = parseHTML(
    '<html><head></head><body><div id="bghsa-owned"></div></body></html>'
  );
  const doc = /** @type {Document} */ (/** @type {unknown} */ (document));
  const owned = doc.getElementById('bghsa-owned');
  if (owned === null) throw new Error('the page carries no owned element');
  return { doc, owned };
}

test("a burst of nothing but the surface's own writing schedules no pass", async () => {
  const { doc, owned } = page();
  let passes = 0;
  const observer = dom.watch(doc, {
    ownedSelector: () => '#bghsa-owned',
    outOfPlace: () => false,
    pass: async () => {
      passes += 1;
    },
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    owned.append(doc.createElement('span'));
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 0, `the surface's own writing ran ${passes} passes`);
  } finally {
    observer?.disconnect();
  }
});

test('a surface left behind takes a pass on its own writing alone', async () => {
  const { doc, owned } = page();
  let passes = 0;
  const observer = dom.watch(doc, {
    ownedSelector: () => '#bghsa-owned',
    outOfPlace: () => true,
    pass: async () => {
      passes += 1;
    },
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    owned.append(doc.createElement('span'));
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 1, 'a surface that is out of place was left there');
  } finally {
    observer?.disconnect();
  }
});

test('two bursts inside the delay take one pass between them', async () => {
  const { doc } = page();
  let passes = 0;
  const observer = dom.watch(doc, {
    ownedSelector: () => '#bghsa-owned',
    outOfPlace: () => false,
    pass: async () => {
      passes += 1;
    },
  });
  assert.ok(observer !== null, 'the document offered no observer');
  try {
    doc.body?.append(doc.createElement('span'));
    // Deliver the first mutation before the debounced render pass runs.
    await delay(1);
    doc.body?.append(doc.createElement('span'));
    await delay(dom.RENDER_DELAY_MS + 50);
    assert.strictEqual(passes, 1, `two changes inside one delay ran ${passes} passes`);
  } finally {
    observer?.disconnect();
  }
});
