'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');

const parseList = require('../src/common/parse-list.js');
const parseDetail = require('../src/common/parse-detail.js');
const cache = require('../src/common/cache.js');
const schema = require('../src/common/schema.js');
const table = require('../src/list/table.js');
const chips = require('../src/common/chips.js');
const fetchQueue = require('../src/common/fetch.js');

const allowlist = require('../src/common/allowlist.js');

const { fakeStorage } = require('../test-support/storage.js');

test.before(async () => {
  allowlist.setStorage({
    get: async () => ({ [allowlist.STORAGE_KEY]: ['git-utensils/spoon-knife'] }),
    set: async () => {},
  });
  await allowlist.load();
});

const AT = Date.parse('2026-08-26T12:00:00Z');

const OBSERVED = Date.parse('2026-08-26T10:00:00Z');

let clockAt = AT;

cache.setClock(() => clockAt);

globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

const MINUTE = 60 * 1000;

const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

globalThis.location = /** @type {Location} */ (
  /** @type {unknown} */ ({ pathname: `/${REF.owner}/${REF.repo}/security/advisories` })
);

/**
 * @param {string} name
 * @returns {string} one fixture's markup.
 */
function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
}

/**
 * @param {string} name
 * @returns {Document}
 */
function listPage(name) {
  const html = [
    '<!doctype html><html><head></head><body>',
    '<div id="repo-content-turbo-frame">',
    fixture(name),
    '</div></body></html>',
  ].join('');
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * @param {string} name
 * @returns {unknown}
 */
function storedAdvisory(name) {
  const html = fixture(name);
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const record = parseDetail.parseDetail(doc);
  if (record === null) throw new Error(`${name} is not an advisory detail page`);
  return JSON.parse(JSON.stringify(record));
}

const TRIAGE_RECORD = storedAdvisory('triage-thread.html');
const DRAFT_RECORD = storedAdvisory('draft.html');

/**
 * @param {string} ghsaId
 * @returns {string} the key that advisory's cache entry is held under.
 */
function keyFor(ghsaId) {
  const key = cache.advisoryKey({ ...REF, ghsaId });
  if (key === null) throw new Error(`no cache key for ${ghsaId}`);
  return key;
}

/**
 * @param {unknown} record
 * @param {string} state
 * @returns {import('../src/common/cache.js').CacheEntry}
 */
function entryOf(record, state) {
  return { record, observedAt: OBSERVED, state };
}

/**
 * @param {ParentNode} scope
 * @param {string} selector
 * @returns {Element}
 */
function one(scope, selector) {
  const found = scope.querySelector(selector);
  if (found === null) throw new Error(`nothing matched ${selector}`);
  return found;
}

/**
 * @param {ParentNode} scope
 * @param {string} selector
 * @returns {string} the matched element's text, whitespace collapsed.
 */
function textOf(scope, selector) {
  return (one(scope, selector).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Return chip classes other than the shared Label class.
 *
 * @param {Element} label
 * @returns {string}
 */
function chipColor(label) {
  return (label.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((name) => name !== '' && name !== 'Label')
    .join(' ');
}

/**
 * Format each chip as text followed by its classes in brackets.
 *
 * @param {Element} row
 * @returns {string}
 */
function chipLine(row) {
  return Array.from(one(row, '.bghsa-list-chips').querySelectorAll('span.Label'))
    .map((label) => {
      const text = (label.textContent ?? '').replace(/\s+/g, ' ').trim();
      return `${text}[${chipColor(label)}]`;
    })
    .join(' | ');
}

/**
 * @param {Element} row
 * @returns {string[]} The columns after the title, in display order.
 */
function cellsOf(row) {
  return Array.from(row.children)
    .slice(1)
    .map((cell) => {
      if (cell.querySelector('.bghsa-list-owners') !== null) return 'owners';
      if (cell.classList.contains('bghsa-list-state')) return 'state';
      if (cell.classList.contains('bghsa-list-observed')) return 'observed';
      return cell.getAttribute('class') ?? '';
    });
}

/**
 * @param {Document} doc
 * @returns {Element[]} the extension's rows.
 */
function tableRows(doc) {
  return Array.from(doc.querySelectorAll(`#${table.ROOT_ID} li.bghsa-list-row`));
}

/**
 * @param {Document} doc
 * @param {Record<string, unknown>} [held] What the cache holds for this render.
 * @returns {Promise<Element>} the table this page renders to.
 */
async function render(doc, held = {}) {
  cache.setStorage(fakeStorage(held));
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');
  return root;
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle between the two views.
 */
function toggleIn(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-list-toggle`))
  );
}

test("a triage row carries what GitHub's row carried, from the list markup alone", async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);

  const rows = tableRows(doc);
  assert.ok(rows.length === 1, `rows on the triage page: ${rows.length}`);
  const row = /** @type {Element} */ (rows[0]);

  const link = one(row, 'a.Link--primary');
  const title = (link.textContent ?? '').trim();
  assert.ok(
    title === 'Path traversal in drawer handler allows reading arbitrary files',
    `title: ${title}`
  );
  const href = link.getAttribute('href');
  assert.ok(
    href === '/git-utensils/Spoon-Knife/security/advisories/GHSA-jmvx-2wfw-xfgj',
    `href: ${href}`
  );

  const meta = textOf(row, '.bghsa-list-meta');
  assert.ok(meta === 'GHSA-jmvx-2wfw-xfgj opened 2026-08-25 by prakleumas', `meta line: ${meta}`);

  const state = textOf(row, '.bghsa-list-state');
  assert.ok(state === 'Triage', `state: ${state}`);

  // The fixture supplies Label--orange. The scoring is unconfirmed,
  // which adds bghsa-dim.
  const chips = chipLine(row);
  assert.ok(chips === 'High[Label--orange bghsa-dim]', `chips with nothing read: ${chips}`);

  // Seeing a list row does not count as reading the advisory.
  const observed = textOf(row, '.bghsa-list-observed');
  assert.ok(observed === 'Not read', `observed: ${observed}`);

  assert.ok(row.querySelector('.bghsa-list-owners') === null, 'an unowned row shows no owner icon');
});

test('a cached advisory read fills the triage row', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(TRIAGE_RECORD, 'triage') });

  const row = /** @type {Element} */ (tableRows(doc)[0]);
  const chips = chipLine(row);
  assert.ok(
    chips ===
      'Awaiting reporter[Label--secondary bghsa-tone-attention] |' +
        ' Backports 1 of 1[Label--secondary] |' +
        ' High, unconfirmed[Label--orange bghsa-dim] |' +
        ' Embargo lifts 2026-09-30[Label--secondary bghsa-tone-attention]',
    `chips from the cached read: ${chips}`
  );

  const owner = one(row, '.bghsa-list-owners a');
  const ownerHref = owner.getAttribute('href');
  assert.ok(ownerHref === '/samuelkarp', `owner link: ${ownerHref}`);
  const avatar = one(owner, 'img.avatar.avatar-user');
  const alt = avatar.getAttribute('alt');
  assert.ok(alt === '@samuelkarp', `owner avatar alt text: ${alt}`);
  const title = avatar.getAttribute('title');
  assert.ok(title === 'samuelkarp', `owner avatar title: ${title}`);
  const width = avatar.getAttribute('width');
  assert.ok(width === '20', `owner avatar width: ${width}`);
  // Snapshots store owner logins. GitHub redirects login-based avatar URLs
  // to account-ID URLs.
  const src = avatar.getAttribute('src');
  assert.ok(
    src === 'https://github.com/samuelkarp.png?size=40',
    `owner avatar source: ${src}`
  );

  const observed = textOf(row, '.bghsa-list-observed');
  assert.ok(observed === 'Observed 2026-08-26 10:00 UTC', `observed: ${observed}`);
});

/**
 * @param {unknown} record
 * @param {string} commentId The comment ID to update.
 * @param {Record<string, string>} scoring
 * @returns {unknown}
 */
function withScoringConfirmed(record, commentId, scoring) {
  const copy = /** @type {import('../src/common/parse-detail.js').ParsedDetail} */ (
    structuredClone(/** @type {object} */ (record))
  );
  const comment = copy.comments.find((entry) => entry.id === commentId);
  if (comment === undefined || comment.stateComment === null) {
    throw new Error(`no snapshot on comment ${commentId}`);
  }
  const snapshot = JSON.parse(comment.stateComment.raw);
  snapshot.confirmed.scoring = scoring;
  comment.stateComment.raw = JSON.stringify(snapshot, null, 2);
  return copy;
}

test('a severity a maintainer confirmed reads confirmed on a cached row', async () => {
  const stored = /** @type {import('../src/common/parse-detail.js').ParsedDetail} */ (
    TRIAGE_RECORD
  );
  // Scoring confirmation covers both severity and vector in trusted comment 282847.
  const record = withScoringConfirmed(TRIAGE_RECORD, '282847', {
    by: 'samuelkarp',
    at: '2026-08-25T18:04:11Z',
    fp: await schema.scoringFingerprint(stored.severityField, stored.cvssV3),
  });

  const doc = listPage('list-page-triage.html');
  await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(record, 'triage') });

  const row = /** @type {Element} */ (tableRows(doc)[0]);
  const severity = Array.from(
    one(row, '.bghsa-list-chips').querySelectorAll(
      `span.Label[${chips.SUBJECT_ATTRIBUTE}="${chips.SEVERITY_SUBJECT}"]`
    )
  ).map(
    (label) => `${(label.textContent ?? '').replace(/\s+/g, ' ').trim()}[${chipColor(label)}]`
  );
  assert.ok(
    severity.length === 1 && severity[0] === 'High[Label--orange bghsa-fill]',
    `the severity chip with the scoring confirmed: ${severity.join(' | ')}` +
      ` (every chip on the row: ${chipLine(row)})`
  );
});

test('a score whose vector moved since it was confirmed reads unconfirmed on a cached row', async () => {
  const stored = /** @type {import('../src/common/parse-detail.js').ParsedDetail} */ (
    TRIAGE_RECORD
  );

  /**
   * Render the severity chip with a confirmation for the supplied vector.
   *
   * @param {string | null} vector The confirmed vector.
   * @returns {Promise<string>}
   */
  const severityChipFor = async (vector) => {
    const record = withScoringConfirmed(TRIAGE_RECORD, '282847', {
      by: 'samuelkarp',
      at: '2026-08-25T18:04:11Z',
      fp: await schema.scoringFingerprint(stored.severityField, vector),
    });
    const doc = listPage('list-page-triage.html');
    await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(record, 'triage') });
    const row = /** @type {Element} */ (tableRows(doc)[0]);
    const found = Array.from(
      one(row, '.bghsa-list-chips').querySelectorAll(
        `span.Label[${chips.SUBJECT_ATTRIBUTE}="${chips.SEVERITY_SUBJECT}"]`
      )
    ).map(
      (label) => `${(label.textContent ?? '').replace(/\s+/g, ' ').trim()}[${chipColor(label)}]`
    );
    if (found.length !== 1) {
      throw new Error(
        `the row drew ${found.length} severity chips: ${found.join(' | ')}` +
          ` (every chip on the row: ${chipLine(row)})`
      );
    }
    return /** @type {string} */ (found[0]);
  };

  // Change only the vector to invalidate the scoring confirmation.
  const bound = await severityChipFor(stored.cvssV3);
  const moved = await severityChipFor('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N');

  assert.ok(
    moved === 'High, unconfirmed[Label--orange bghsa-dim]' && bound !== moved,
    `the severity chip bound to the stored score: ${bound};` +
      ` bound to a score that moved: ${moved}`
  );
});

test('the cells beside a row are the owners, the state, and the observation', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(TRIAGE_RECORD, 'triage') });

  const row = /** @type {Element} */ (tableRows(doc)[0]);
  assert.deepStrictEqual(cellsOf(row), ['owners', 'state', 'observed']);
});

test('an owner login is encoded the same way in the link and the avatar', () => {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML('<!doctype html><html><body></body></html>').document)
  );
  // Logins from state comments require escaping in both avatar and profile URLs.
  const box = table.buildOwners(doc, ['a b/c?d#e']);
  const link = one(box, 'a');
  const href = link.getAttribute('href');
  assert.ok(href === '/a%20b%2Fc%3Fd%23e', `owner link: ${href}`);
  const src = one(link, 'img').getAttribute('src');
  assert.ok(
    src === 'https://github.com/a%20b%2Fc%3Fd%23e.png?size=40',
    `owner avatar source: ${src}`
  );
});

const OPEN_PATCH = {
  cloneUrl: null,
  repository: 'git-utensils/Spoon-Knife-ghsa-fork',
  deleteUrl: null,
  pullRequests: [
    {
      number: 1,
      url: null,
      title: 'Fix it',
      state: 'open',
      baseRef: 'main',
      headRef: 'fix',
      author: 'samuelkarp',
      openedAt: '2026-08-26T00:00:00Z',
      assignees: [],
    },
  ],
};

/**
 * @param {unknown} record A cached advisory read.
 * @param {unknown} fork The replacement fork.
 * @returns {unknown} that read with its fork replaced, leaving the original as
 *   it was.
 */
function withFork(record, fork) {
  return { ...structuredClone(/** @type {object} */ (record)), fork };
}

/**
 * @param {Document} doc
 * @returns {string} how the first row's state chip is colored.
 */
function stateChipColor(doc) {
  const row = /** @type {Element} */ (tableRows(doc)[0]);
  return chipColor(one(row, '.bghsa-list-state span.Label'));
}

/**
 * @param {Document} doc
 * @returns {string} the chips under the first row's title, as `chipLine` reads
 *   them.
 */
function chipsIn(doc) {
  return chipLine(/** @type {Element} */ (tableRows(doc)[0]));
}

test('the stylesheet carries a rule for every color the chips invent', () => {
  // Extension tone classes require stylesheet rules.
  for (const name of [
    'bghsa-tone-attention',
    'bghsa-tone-danger',
    'bghsa-tone-done',
    'bghsa-tone-success',
    'bghsa-fill',
    'bghsa-dim',
  ]) {
    assert.ok(table.STYLE_TEXT.includes(`.${name} {`), `no rule defines .${name}`);
  }
});

test('the patch chips stand on a draft and the state chip stays dimmed', async () => {
  const unread = listPage('list-page-draft.html');
  await render(unread);
  assert.ok(chipsIn(unread) === '', `a draft nothing has been read on: ${chipsIn(unread)}`);
  assert.ok(
    stateChipColor(unread) === 'Label--secondary',
    `the state chip on a draft nothing has been read on: ${stateChipColor(unread)}`
  );

  const waiting = listPage('list-page-draft.html');
  await render(waiting, { [keyFor('GHSA-5hg2-rfq2-8fm5')]: entryOf(withFork(DRAFT_RECORD, null), 'draft') });
  assert.ok(
    chipsIn(waiting) ===
      'Blocked on us[Label--secondary bghsa-tone-danger] |' +
        ' No patch yet[Label--secondary bghsa-tone-danger]',
    `a draft whose fork holds no pull request: ${chipsIn(waiting)}`
  );
  assert.ok(
    stateChipColor(waiting) === 'Label--secondary',
    `the state chip on a draft with no patch: ${stateChipColor(waiting)}`
  );

  const patched = listPage('list-page-draft.html');
  await render(patched, {
    [keyFor('GHSA-5hg2-rfq2-8fm5')]: entryOf(withFork(DRAFT_RECORD, OPEN_PATCH), 'draft'),
  });
  assert.ok(
    chipsIn(patched) ===
      'Blocked on us[Label--secondary bghsa-tone-danger] |' +
        ' Patch in review[Label--secondary bghsa-tone-attention]',
    `a draft whose fork holds an open pull request: ${chipsIn(patched)}`
  );
  assert.ok(
    stateChipColor(patched) === 'Label--secondary',
    `the state chip on a draft under patch: ${stateChipColor(patched)}`
  );

  // Patch chips apply to draft advisories.
  const triage = listPage('list-page-triage.html');
  await render(triage, {
    [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(withFork(TRIAGE_RECORD, OPEN_PATCH), 'triage'),
  });
  assert.ok(
    chipsIn(triage) ===
      'Awaiting reporter[Label--secondary bghsa-tone-attention] |' +
        ' Backports 0 of 1[Label--secondary bghsa-tone-attention] |' +
        ' High, unconfirmed[Label--orange bghsa-dim] |' +
        ' Embargo lifts 2026-09-30[Label--secondary bghsa-tone-attention]',
    `a triage advisory whose fork holds an open pull request: ${chipsIn(triage)}`
  );

  const untouched = listPage('list-page-triage.html');
  await render(untouched, {
    [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(withFork(TRIAGE_RECORD, null), 'triage'),
  });
  assert.ok(
    chipsIn(untouched) === chipsIn(triage),
    `a triage advisory whose fork holds nothing: ${chipsIn(untouched)}`
  );
  assert.ok(
    stateChipColor(untouched) === 'Label--secondary',
    `the state chip on a triage advisory: ${stateChipColor(untouched)}`
  );
});

test("the table holds GitHub's segmented control, rows, and query form out of view", async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);

  const container = one(doc, '#advisories');
  const controls = table.nativeControls(container);
  assert.ok(controls.length === 3, `controls the table hides: ${controls.length}`);

  const box = /** @type {Element} */ (controls[0]);
  assert.ok(box.querySelector('segmented-control') !== null, 'the hidden Box holds the tabs');
  assert.ok(
    box.querySelector('div.Box-row--drag-hide') !== null,
    "the hidden Box holds GitHub's rows, so restoring them is one act"
  );
  const filter = /** @type {Element} */ (controls[1]);
  assert.ok(
    filter.tagName.toLowerCase() === 'repository-advisories-filter',
    `the second control: ${filter.tagName}`
  );
  const paging = /** @type {Element} */ (controls[2]);
  assert.ok(
    paging.classList.contains('paginate-container'),
    `the third control: ${paging.className}`
  );
  assert.strictEqual(
    paging.closest('div.Box'),
    null,
    'GitHub keeps its pagination outside the Box, which is why hiding the Box misses it'
  );

  for (const control of controls) {
    assert.ok(
      control.classList.contains(table.HIDDEN_CLASS),
      `${control.tagName} is out of view while the table shows`
    );
    assert.ok(
      control.closest(`#${table.ROOT_ID}`) === null,
      'the table never hides anything of its own'
    );
  }
});

test('a surface beside the table gets a place on the bar and every view change', async () => {
  /** @type {string[]} */
  const told = [];
  /** @type {import('../src/list/table.js').Surface} */
  const surface = {
    control: (doc) => {
      const node = doc.createElement('button');
      node.className = 'probe-control';
      node.textContent = 'Probe';
      node.addEventListener('click', () => {
        table.setViewMode(doc, table.viewMode(doc) === 'probe' ? table.VIEW_TABLE : 'probe');
        table.applyVisibility(doc);
      });
      return node;
    },
    show: (_doc, mode) => told.push(mode),
  };
  table.addSurface(surface);
  try {
    const doc = listPage('list-page-triage.html');
    await render(doc);
    assert.ok(
      one(doc, '.probe-control').closest(`#${table.ROOT_ID} .bghsa-list-bar`) !== null,
      'the control sits on the bar'
    );
    assert.deepStrictEqual(told, [table.VIEW_TABLE], `told after the first render: ${told}`);

    const box = one(doc, `#${table.ROOT_ID} .bghsa-list-box`);
    const nativeBox = /** @type {Element} */ (table.nativeControls(one(doc, '#advisories'))[0]);

    /** @type {HTMLElement} */ (/** @type {unknown} */ (one(doc, '.probe-control'))).click();
    assert.deepStrictEqual(told, [table.VIEW_TABLE, 'probe'], `told after the probe: ${told}`);
    assert.ok(box.classList.contains(table.HIDDEN_CLASS), 'the table gives way to the surface');
    assert.ok(
      nativeBox.classList.contains(table.HIDDEN_CLASS),
      "GitHub's view stays out of the way of the surface"
    );
    assert.strictEqual(table.showingNative(doc), false, 'the surface is not GitHub\'s view');
    assert.strictEqual(
      (toggleIn(doc).textContent ?? '').trim(),
      table.SHOW_GITHUB,
      "the GitHub toggle still offers GitHub's view"
    );

    toggleIn(doc).click();
    assert.strictEqual(table.viewMode(doc), table.VIEW_NATIVE, 'the surface gave way');
    assert.ok(!nativeBox.classList.contains(table.HIDDEN_CLASS), "GitHub's view is back");
    toggleIn(doc).click();
    assert.strictEqual(table.viewMode(doc), table.VIEW_TABLE, 'the table is back');
    assert.ok(!box.classList.contains(table.HIDDEN_CLASS), 'the table is in view');
    assert.deepStrictEqual(
      told,
      [table.VIEW_TABLE, 'probe', table.VIEW_NATIVE, table.VIEW_TABLE],
      `told over the cycle: ${told}`
    );
  } finally {
    table.surfaces.splice(table.surfaces.indexOf(surface), 1);
  }
});

test('injecting twice leaves one table and one stylesheet', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);
  await render(doc);

  const roots = doc.querySelectorAll(`#${table.ROOT_ID}`).length;
  assert.ok(roots === 1, `tables after two injections: ${roots}`);
  const styles = doc.querySelectorAll(`style#${table.STYLE_ID}`).length;
  assert.ok(styles === 1, `stylesheets after two injections: ${styles}`);
  const rows = tableRows(doc).length;
  assert.ok(rows === 1, `rows after two injections: ${rows}`);
});

test('a render after GitHub replaced the subtree puts the table back', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc);

  const frame = one(doc, '#repo-content-turbo-frame');
  const fresh = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML(`<div>${fixture('list-page-triage.html')}</div>`).document)
  );
  one(doc, '#advisories').replaceWith(one(fresh, '#advisories'));

  assert.ok(doc.getElementById(table.ROOT_ID) === null, 'the replacement took the table with it');
  assert.ok(table.outOfPlace(doc), 'the document is asking for a pass');
  assert.ok(frame.querySelector('#advisories') !== null, 'the fresh list is in the frame');

  await render(doc);
  const roots = doc.querySelectorAll(`#${table.ROOT_ID}`).length;
  assert.ok(roots === 1, `tables after the replacement: ${roots}`);
  const rows = tableRows(doc).length;
  assert.ok(rows === 1, `rows after the replacement: ${rows}`);
});

test('a table left behind at the wrong place is put back', async () => {
  const doc = listPage('list-page-triage.html');
  const root = await render(doc);
  assert.ok(!table.outOfPlace(doc), 'a fresh injection sits at the anchor');

  one(doc, '#advisories').append(root);
  assert.ok(table.outOfPlace(doc), 'a table moved off the anchor is out of place');

  await render(doc);
  assert.ok(!table.outOfPlace(doc), 'the pass put it back');
  const roots = doc.querySelectorAll(`#${table.ROOT_ID}`).length;
  assert.ok(roots === 1, `tables after the pass: ${roots}`);
});

test('parse-list cannot read the table the extension inserts', async () => {
  const doc = listPage('list-page-triage.html');
  const before = parseList.parseList(doc);
  if (before === null) throw new Error('the fixture is not a list page');

  const root = await render(doc);

  const after = parseList.parseList(doc);
  if (after === null) throw new Error('the injected page stopped reading as a list page');
  assert.ok(after.rows.length === before.rows.length, `rows re-read: ${after.rows.length}`);
  const title = after.rows[0]?.title ?? null;
  assert.ok(title === (before.rows[0]?.title ?? null), `the row re-read: ${title}`);
  assert.ok(after.tabs.length === before.tabs.length, `tabs re-read: ${after.tabs.length}`);
  assert.ok(after.next === null, 'the table adds no next page');

  // Extension rows must omit the selectors used to identify GitHub list rows.
  const matched = root.querySelectorAll(table.PARSED_SELECTORS.join(', ')).length;
  assert.ok(matched === 0, `nodes in the table the parser would read: ${matched}`);
});

test('the CVE a row carries is the one the advisory read names', async () => {
  /** @type {Array<[string, Record<string, unknown>, string | null]>} */
  const wanted = [
    ['GHSA-aaaa-aaaa-aaaa', { cveId: 'CVE-2026-12345' }, 'CVE-2026-12345'],
    [
      'GHSA-bbbb-bbbb-bbbb',
      {
        cveId: null,
        timeline: [
          { id: null, actor: 'samuelkarp', at: '2026-08-20T00:00:00Z', text: 'samuelkarp requested a CVE' },
        ],
      },
      'CVE requested',
    ],
    ['GHSA-cccc-cccc-cccc', { cveId: null, cveSelection: 'not_applicable' }, 'CVE not applicable'],
    ['GHSA-dddd-dddd-dddd', { cveId: null, cveSelection: null }, null],
  ];

  const storage = fakeStorage();
  cache.setStorage(storage);
  try {
    for (const [ghsaId, fields] of wanted) {
      const held = /** @type {Record<string, unknown>} */ (TRIAGE_RECORD);
      await cache.putAdvisory({ ...REF, ghsaId }, { ...held, ghsaId, ...fields }, {
        storage,
        at: OBSERVED,
      });
    }
    /** @type {import('../src/common/parse-list.js').ParsedList} */
    const parsed = {
      ...REF,
      rows: wanted.map(([ghsaId]) => listRow(String(ghsaId), '2026-08-01T00:00:00Z')),
      tabs: [],
      selectedState: 'triage',
      next: null,
      openCount: wanted.length,
    };
    const view = await table.readView(parsed, { at: AT });
    for (const [ghsaId, , cve] of wanted) {
      const row = view.rows.find((each) => each.ghsaId === ghsaId);
      assert.ok(row?.read === true, `${ghsaId} was not read`);
      assert.strictEqual(row?.cve, cve, `${ghsaId} carries another CVE`);
    }
  } finally {
    cache.setStorage(null);
  }
});

test('the default order puts the longest waiting first', async () => {
  /** @type {import('../src/common/parse-list.js').ParsedList} */
  const parsed = {
    ...REF,
    rows: [
      listRow('GHSA-bbbb-bbbb-bbbb', '2026-08-20T00:00:00Z'),
      listRow('GHSA-aaaa-aaaa-aaaa', '2026-08-01T00:00:00Z'),
      listRow('GHSA-cccc-cccc-cccc', '2026-08-10T00:00:00Z'),
    ],
    tabs: [],
    selectedState: 'triage',
    next: null,
    openCount: 3,
  };
  cache.setStorage(fakeStorage());
  const view = await table.readView(parsed, { at: AT });
  const order = view.rows.map((row) => row.ghsaId).join(' ');
  assert.ok(
    order === 'GHSA-aaaa-aaaa-aaaa GHSA-cccc-cccc-cccc GHSA-bbbb-bbbb-bbbb',
    `default order: ${order}`
  );
});

/**
 * @param {string} ghsaId
 * @param {string} openedAt
 * @returns {import('../src/common/parse-list.js').ListRow}
 */
function listRow(ghsaId, openedAt) {
  return {
    ghsaId,
    owner: REF.owner,
    repo: REF.repo,
    href: `/${REF.owner}/${REF.repo}/security/advisories/${ghsaId}`,
    title: ghsaId,
    state: 'Triage',
    severity: null,
    severityLabel: null,
    severityClass: null,
    openedAt,
    reporter: 'prakleumas',
  };
}

/**
 * @param {Partial<import('../src/list/table.js').TableRow>} [changes]
 * @returns {import('../src/list/table.js').TableRow}
 */
function rowWith(changes = {}) {
  return { ...table.unreadRow(listRow('GHSA-aaaa-aaaa-aaaa', '2026-08-01T00:00:00Z'), AT), ...changes };
}

/**
 * @param {Partial<import('../src/list/table.js').TableRow>} [changes]
 * @returns {string}
 */
function chipsOf(changes = {}) {
  return table
    .chipsFor(rowWith(changes))
    .map((spec) => {
      /** @type {string[]} */
      const marks = [];
      if (spec.tone !== undefined) marks.push(spec.tone);
      if (spec.severityClass !== undefined && spec.severityClass !== null) {
        marks.push(spec.severityClass);
      }
      if (spec.fill === true) marks.push('fill');
      if (spec.dim === true) marks.push('dim');
      return marks.length === 0 ? spec.text : `${spec.text}[${marks.join(' ')}]`;
    })
    .join(' | ');
}

test('a chip stands for a condition that holds and is absent when it does not', () => {
  const none = chipsOf();
  assert.ok(none === '', `a row with nothing to say: ${none}`);

  const unread = chipsOf({ triage: 'evaluating' });
  assert.ok(unread === '', `a row nothing has been read on: ${unread}`);

  const reviewed = chipsOf({ read: true, neverReviewed: true });
  assert.ok(reviewed === 'Never reviewed[danger]', `never reviewed: ${reviewed}`);

  const activity = chipsOf({ read: true, newActivity: true });
  assert.ok(activity === 'New activity[attention]', `new activity: ${activity}`);

  const blocked = chipsOf({ read: true });
  assert.ok(
    blocked === 'Blocked on us[danger]',
    `a row nobody has triaged still says which side it waits on: ${blocked}`
  );

  const evaluating = chipsOf({ read: true, triage: 'evaluating' });
  assert.ok(
    evaluating === 'Evaluating[danger]',
    `what a maintainer owes is loud: ${evaluating}`
  );

  const asked = chipsOf({ read: true, triage: 'awaiting maintainer input' });
  assert.ok(
    asked === 'Awaiting maintainer input[danger]',
    `a maintainer was asked for something: ${asked}`
  );

  const reporter = chipsOf({ read: true, triage: 'awaiting reporter' });
  assert.ok(
    reporter === 'Awaiting reporter[attention]',
    `what the reporter owes is quieter: ${reporter}`
  );

  // New reporter activity adds a derived chip before the stored triage value.
  const both = chipsOf({ read: true, newActivity: true, triage: 'evaluating' });
  assert.ok(
    both === 'New activity[attention] | Evaluating[danger]',
    `a reporter who spoke while a maintainer was evaluating: ${both}`
  );
});

test('the severity chip marks the unconfirmed case and no other', () => {
  const unread = chipsOf({ severityLabel: 'Critical' });
  assert.ok(unread === 'Critical[dim]', `nothing read, so nobody has confirmed it: ${unread}`);

  const unconfirmed = chipsOf({ read: true, severityLabel: 'Critical' });
  assert.ok(
    unconfirmed === 'Blocked on us[danger] | Critical, unconfirmed[dim]',
    `severity nobody confirmed: ${unconfirmed}`
  );

  const confirmed = chipsOf({ read: true, severityLabel: 'Low', severityConfirmed: true });
  assert.ok(
    confirmed === 'Blocked on us[danger] | Low[fill]',
    `severity a maintainer confirmed: ${confirmed}`
  );

  const noSeverity = chipsOf({ read: true, severityConfirmed: true });
  assert.ok(noSeverity === 'Blocked on us[danger]', `no severity set: ${noSeverity}`);
});

test('the severity chip takes the class GitHub painted, not one off the level', () => {
  // Pair Critical with Label--orange to check that the supplied class is preserved.
  const carried = chipsOf({
    read: true,
    severityLabel: 'Critical',
    severityClass: 'Label--orange',
    severityConfirmed: true,
  });
  assert.ok(
    carried === 'Blocked on us[danger] | Critical[Label--orange fill]',
    `the class GitHub painted: ${carried}`
  );

  const dimmed = chipsOf({ read: true, severityLabel: 'Critical', severityClass: 'Label--orange' });
  assert.ok(
    dimmed === 'Blocked on us[danger] | Critical, unconfirmed[Label--orange dim]',
    `the same class, held back while nobody has confirmed it: ${dimmed}`
  );

  const bare = chipsOf({ read: true, severityLabel: 'Critical', severityConfirmed: true });
  assert.ok(
    bare === 'Blocked on us[danger] | Critical[fill]',
    `no class on GitHub's chip: ${bare}`
  );
});

test('a confirmed severity is drawn filled and an unconfirmed one is not', () => {
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', {
      read: true,
      severity: 'high',
      severityLabel: 'High',
      severityClass: 'Label--orange',
      severityConfirmed: true,
    }),
    sortRow('GHSA-bbbb-bbbb-bbbb', {
      read: true,
      severity: 'high',
      severityLabel: 'High',
      severityClass: 'Label--orange',
    }),
  ]);
  const drawn = tableRows(doc).map(chipLine);
  assert.ok(
    drawn[0]?.endsWith('High[Label--orange bghsa-fill]') === true,
    `the chip of a severity a maintainer confirmed: ${drawn[0]}`
  );
  assert.ok(
    drawn[1]?.endsWith('High, unconfirmed[Label--orange bghsa-dim]') === true,
    `the chip of a severity nobody has confirmed: ${drawn[1]}`
  );
});

test('the CVE, patch, backport, and embargo chips read what the advisory holds', () => {
  const assigned = chipsOf({ read: true, cve: 'CVE-2026-12345' });
  assert.ok(
    assigned === 'Blocked on us[danger] | CVE-2026-12345',
    `an assigned CVE: ${assigned}`
  );

  const draft = { read: true, state: 'Draft' };

  const none = chipsOf({ ...draft, patch: 'No patch yet' });
  assert.ok(
    none === 'Blocked on us[danger] | No patch yet[danger]',
    `a draft nobody has patched: ${none}`
  );

  const inReview = chipsOf({ ...draft, patch: 'Patch in review' });
  assert.ok(
    inReview === 'Blocked on us[danger] | Patch in review[attention]',
    `a patch under review: ${inReview}`
  );

  // An unrecognized pull request state makes patch status unknown.
  const unjudged = chipsOf({ ...draft, patch: 'Unknown' });
  assert.ok(unjudged === 'Blocked on us[danger] | Unknown', `a patch state nobody read: ${unjudged}`);

  for (const held of [
    { patch: 'No patch yet' },
    { patch: 'Patch in review' },
    { patch: 'Unknown' },
  ]) {
    const triage = chipsOf({ read: true, state: 'Triage', ...held });
    assert.ok(
      triage === 'Blocked on us[danger]',
      `a triage advisory holding ${JSON.stringify(held)}: ${triage}`
    );
  }

  const backports = chipsOf({ read: true, backportTargets: 3, backportsDone: 2 });
  assert.ok(
    backports === 'Blocked on us[danger] | Backports 2 of 3[attention]',
    `backports short of the targets set: ${backports}`
  );

  const complete = chipsOf({ read: true, backportTargets: 3, backportsDone: 3 });
  assert.ok(
    complete === 'Blocked on us[danger] | Backports 3 of 3',
    `every target carries an open pull request: ${complete}`
  );

  const embargo = chipsOf({ read: true, embargo: true, embargoLift: '2026-09-30' });
  assert.ok(
    embargo === 'Blocked on us[danger] | Embargo lifts 2026-09-30[attention]',
    `an embargo in force: ${embargo}`
  );

  const undated = chipsOf({ read: true, embargo: true });
  assert.ok(
    undated === 'Blocked on us[danger] | Embargo, no lift date[attention]',
    `an embargo with no date: ${undated}`
  );

  // Embargo chips must express overdue status in text as well as color.
  const overdue = chipsOf({ read: true, embargo: true, embargoLift: '2026-08-01', embargoOverdue: true });
  assert.ok(
    overdue === 'Blocked on us[danger] | Embargo overdue since 2026-08-01[danger]',
    `an embargo a maintainer has to act on: ${overdue}`
  );
});

/**
 * @param {readonly {branch: string, open: boolean}[]} branches
 * @returns {import('../src/common/derive.js').PatchState}
 */
function branchesOf(branches) {
  return {
    hasFork: true,
    pullRequests: [],
    branches: branches.map((entry) => ({ branch: entry.branch, pullRequests: [], open: entry.open })),
    open: [],
    unknown: [],
    incomplete: false,
  };
}

// GitHub lists only open fork pull requests. Backport progress counts
// prepared targets (REQUIREMENTS.md section 6).
test('backport progress counts the targets holding an open pull request', () => {
  const patch = branchesOf([
    { branch: 'release/1.0', open: false },
    { branch: 'release/1.1', open: true },
    { branch: 'release/1.2', open: true },
    { branch: 'release/1.3', open: false },
  ]);
  const targets = ['release/1.0', 'release/1.1', 'release/1.2', 'release/1.3'];
  const done = table.backportsDoneIn(patch, targets);
  assert.ok(done === 2, `two of the four targets hold an open pull request: ${done}`);
});

test('a branch the fork patches that nobody asked for is not backport progress', () => {
  const patch = branchesOf([
    { branch: 'main', open: true },
    { branch: 'release/1.1', open: true },
  ]);
  const done = table.backportsDoneIn(patch, ['release/1.1', 'release/1.2']);
  assert.ok(done === 1, `only the asked-for branch counts: ${done}`);
});

test('a page that is not an advisory list gets no table', async () => {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML('<!doctype html><html><body><div id="x"></div></body></html>').document)
  );
  cache.setStorage(fakeStorage());
  const root = await table.render(doc);
  assert.ok(root === null, 'nothing to render into');
  assert.ok(doc.getElementById(table.ROOT_ID) === null, 'and nothing rendered');
});

/**
 * @param {{ owner: string, repo: string, state: string, ids: readonly string[], next?: string }} page
 * @returns {string}
 */
function listHtml(page) {
  const label = /** @type {string} */ (parseList.STATES[page.state]);
  const base = `/${page.owner}/${page.repo}/security/advisories`;
  const tabs = Object.entries(parseList.STATES)
    .map(
      ([state, name]) =>
        `<li><a href="${base}?state=${state}"${
          state === page.state ? ' aria-current="true"' : ''
        }>1 ${name}</a></li>`
    )
    .join('');
  const rows = page.ids
    .map(
      (id) =>
        '<div class="Box-row Box-row--drag-hide">' +
        `<a class="Link--primary" href="${base}/${id}">Title ${id}</a>` +
        `<span class="tooltipped" aria-label="${label} advisory"></span>` +
        '<span class="opened-by">opened <relative-time datetime="2026-08-01T00:00:00Z">' +
        '</relative-time> by <a class="author" href="/prakleumas">prakleumas</a></span>' +
        '</div>'
    )
    .join('');
  const next = page.next === undefined ? '' : `<a rel="next" href="${page.next}">Next</a>`;
  return (
    `<div id="advisories"><segmented-control><ul>${tabs}</ul></segmented-control>` +
    `<div class="Box">${rows}</div>${next}</div>`
  );
}

/**
 * @param {string} ghsaId
 * @param {string} state
 * @param {string} [severity]
 * @param {string} [severityClass] The modifier GitHub paints the severity chip
 *   with, and the empty string for a chip carrying none.
 * @returns {string}
 */
function detailHtml(ghsaId, state, severity = 'High', severityClass = '') {
  const modifiers = severityClass === '' ? '' : ` ${severityClass}`;
  return (
    '<!doctype html><html><body><div class="gh-header-meta">' +
    `<span class="State">${state}</span>` +
    `<span class="Label Label--large${modifiers}" title="Severity: ${severity}">${severity}</span>` +
    `<span class="user-select-contain">${ghsaId}</span>` +
    '</div></body></html>'
  );
}

/**
 * @param {string} ghsaId
 * @param {string} state
 * @param {string} [severity]
 * @returns {unknown} that advisory as the cache holds it.
 */
function storedDetail(ghsaId, state, severity) {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML(detailHtml(ghsaId, state, severity)).document)
  );
  const record = parseDetail.parseDetail(doc);
  if (record === null) throw new Error(`${ghsaId} did not read as an advisory`);
  return JSON.parse(JSON.stringify(record));
}

/**
 * @param {Record<string, string>} pages
 */
function fakeFetch(pages) {
  /** @type {string[]} */
  const urls = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    urls.push(String(url));
    const body = pages[String(url)];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  };
  return { urls, send };
}

/**
 * Advance the fake clock by the requested duration.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function advance(ms) {
  clockAt += ms;
}

/**
 * @param {string} html
 * @returns {Document}
 */
function pageOf(html) {
  return /** @type {Document} */ (
    /** @type {unknown} */ (
      parseHTML(`<!doctype html><html><body><div id="repo-content-turbo-frame">${html}</div></body></html>`)
        .document
    )
  );
}

test('a row no advisory read backs says so, whenever its markup was seen', async () => {
  const owner = 'observed-crawl';
  const repo = 'repo';
  const ghsaId = 'GHSA-aaaa-aaaa-aaaa';
  const base = `/${owner}/${repo}/security/advisories`;
  const seenAt = Date.parse('2026-08-24T09:00:00Z');

  // The draft row is on the current page. The triage row was last seen
  // two days ago, even though later crawls rewrote its list record.
  const drawn = 'GHSA-bbbb-bbbb-bbbb';
  const doc = pageOf(listHtml({ owner, repo, state: 'draft', ids: [drawn] }));
  const storage = fakeStorage();
  await cache.putList(
    { owner, repo },
    {
      walks: {},
      rows: {
        [ghsaId]: {
          row: {
            ghsaId,
            owner,
            repo,
            href: `${base}/${ghsaId}`,
            title: `Title ${ghsaId}`,
            state: 'Triage',
            severity: null,
            severityLabel: null,
            severityClass: null,
            openedAt: '2026-08-01T00:00:00Z',
            reporter: 'prakleumas',
          },
          state: 'triage',
          seenAt,
        },
      },
    },
    { storage, at: AT }
  );
  cache.setStorage(storage);
  await table.render(doc);

  const rows = tableRows(doc);
  assert.ok(rows.length === 2, `rows on the page: ${rows.length}`);
  const observed = new Map(
    rows.map((row) => [row.getAttribute('data-bghsa-ghsa'), textOf(row, '.bghsa-list-observed')])
  );
  assert.ok(observed.get(ghsaId) === 'Not read', `the crawled row: ${observed.get(ghsaId)}`);
  assert.ok(observed.get(drawn) === 'Not read', `the row on the page: ${observed.get(drawn)}`);
});

test('a read supplies every value on the row it stamps', async () => {
  // The current list row and cached advisory disagree.
  // The displayed values must match the advisory observation time.
  const source = {
    row: {
      ghsaId: 'GHSA-aaaa-aaaa-aaaa',
      owner: 'observed-mix',
      repo: 'repo',
      href: '/observed-mix/repo/security/advisories/GHSA-aaaa-aaaa-aaaa',
      title: 'What the list row says',
      state: 'Triage',
      severity: 'low',
      severityLabel: 'Low',
      severityClass: 'Label--secondary',
      openedAt: '2026-08-01T00:00:00Z',
      reporter: 'prakleumas',
    },
    seenAt: AT,
  };
  const entry = {
    record: parseDetail.parseDetail(
      /** @type {Document} */ (
        /** @type {unknown} */ (
          parseHTML(
            detailHtml('GHSA-aaaa-aaaa-aaaa', 'Draft', 'Critical', 'Label--orange')
          ).document
        )
      )
    ),
    observedAt: OBSERVED,
    state: 'draft',
  };

  const row = await table.viewRow(source, entry, AT);

  assert.ok(row.observedAt === OBSERVED, `the row was stamped ${row.observedAt}`);
  assert.ok(row.state === 'Draft', `state: ${row.state}`);
  assert.ok(row.severity === 'critical', `severity: ${row.severity}`);
  assert.ok(row.severityLabel === 'Critical', `severity label: ${row.severityLabel}`);
  assert.ok(row.severityClass === 'Label--orange', `severity class: ${row.severityClass}`);
  assert.ok(row.title === 'What the list row says', `title: ${row.title}`);
});

test('a read that names no severity leaves the list row painting the chip', async () => {
  const source = {
    row: {
      ghsaId: 'GHSA-aaaa-aaaa-aaaa',
      owner: 'observed-mix',
      repo: 'repo',
      href: '/observed-mix/repo/security/advisories/GHSA-aaaa-aaaa-aaaa',
      title: 'What the list row says',
      state: 'Triage',
      severity: 'low',
      severityLabel: 'Low',
      severityClass: 'Label--secondary',
      openedAt: '2026-08-01T00:00:00Z',
      reporter: 'prakleumas',
    },
    seenAt: AT,
  };
  const row = await table.viewRow(source, entryOf(DRAFT_RECORD, 'draft'), AT);
  assert.ok(row.severityLabel === 'Low', `severity label: ${row.severityLabel}`);
  assert.ok(row.severityClass === 'Label--secondary', `severity class: ${row.severityClass}`);
});

test('a read lands in the row where it stands', async () => {
  const owner = 'crawl-place';
  const ghsaId = 'GHSA-aaaa-aaaa-aaaa';
  const doc = pageOf(listHtml({ owner, repo: 'repo', state: 'triage', ids: [ghsaId] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');

  assert.ok(chipLine(/** @type {Element} */ (tableRows(doc)[0])) === '', 'an unread row has chips');

  const detail = parseDetail.parseDetail(
    /** @type {Document} */ (/** @type {unknown} */ (parseHTML(detailHtml(ghsaId, 'Triage')).document))
  );
  const applied = await table.applyEntry(doc, ghsaId, {
    record: detail,
    observedAt: AT - 30 * MINUTE,
    state: 'triage',
  });

  assert.ok(applied, 'no row was replaced');
  assert.ok(doc.getElementById(table.ROOT_ID) === root, 'the whole table was rebuilt');
  const rows = tableRows(doc);
  assert.ok(rows.length === 1, `rows after the read: ${rows.length}`);
  const row = /** @type {Element} */ (rows[0]);
  assert.ok(
    chipLine(row) === 'Never reviewed[Label--secondary bghsa-tone-danger] |' +
      ' High, unconfirmed[Label--secondary bghsa-dim]',
    `chips after the read: ${chipLine(row)}`
  );
  const observed = textOf(row, '.bghsa-list-observed');
  assert.ok(observed === 'Observed 2026-08-26 11:30 UTC', `observed: ${observed}`);
});

test('a read for an advisory the table is not showing replaces nothing', async () => {
  const doc = pageOf(
    listHtml({ owner: 'crawl-absent', repo: 'repo', state: 'triage', ids: ['GHSA-aaaa-aaaa-aaaa'] })
  );
  cache.setStorage(fakeStorage());
  await table.render(doc);
  const applied = await table.applyEntry(doc, 'GHSA-zzzz-zzzz-zzzz', {
    record: { state: 'Triage' },
    observedAt: AT,
    state: 'triage',
  });
  assert.ok(!applied, 'a row was replaced for an advisory the table does not hold');
});

/**
 * @param {Document} doc
 * @returns {string | null} The refresh status text, or null.
 */
function progressText(doc) {
  const root = doc.getElementById(table.ROOT_ID);
  const chip = root?.querySelector('.bghsa-list-progress') ?? null;
  return chip === null ? null : (chip.textContent ?? '');
}

test('the header says what the refresh is doing and stops when it is done', async () => {
  const owner = 'crawl-progress';
  const repo = 'repo';
  const base = `/${owner}/${repo}/security/advisories`;
  const triage = 'GHSA-aaaa-aaaa-aaaa';
  const first = 'GHSA-bbbb-bbbb-bbbb';
  const second = 'GHSA-cccc-cccc-cccc';
  const doc = pageOf(listHtml({ owner, repo, state: 'triage', ids: [triage] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const fetch = fakeFetch({
    [`${base}?state=draft`]: listHtml({ owner, repo, state: 'draft', ids: [first, second] }),
    [`${base}/${triage}`]: detailHtml(triage, 'Triage'),
    [`${base}/${first}`]: detailHtml(first, 'Draft'),
    [`${base}/${second}`]: detailHtml(second, 'Draft'),
  });

  // Sample when requests start. Jitter can round to zero and skip the wait callback.
  /** @type {(string | null)[]} */
  const said = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url, init) => {
    said.push(progressText(doc));
    return fetch.send(url, init);
  };

  await table.render(doc);
  assert.strictEqual(progressText(doc), null, 'a table nothing is refreshing said it was');

  const summary = await table.refresh(doc, {
    storage,
    fetch: send,
    wait: advance,
    href: `https://github.com${base}?state=triage`,
  });
  assert.ok(summary !== null && summary.read.fetched === 3, 'the three advisories were not read');

  assert.deepStrictEqual(said, [
    table.WALKING_TEXT,
    'Loading (3 left)...',
    'Loading (2 left)...',
    'Loading (1 left)...',
  ]);
  assert.strictEqual(progressText(doc), null, 'the header still said a refresh was running');

  const count = textOf(doc, `#${table.ROOT_ID} .bghsa-list-count`);
  assert.strictEqual(count, '3 advisories', `the header count: ${count}`);
});

test('a refresh that could not read everything stops saying it is running', async () => {
  const owner = 'crawl-progress-failed';
  const repo = 'repo';
  const base = `/${owner}/${repo}/security/advisories`;
  const read = 'GHSA-aaaa-aaaa-aaaa';
  const unread = 'GHSA-cccc-cccc-cccc';
  const doc = pageOf(listHtml({ owner, repo, state: 'triage', ids: [read] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const fetch = fakeFetch({
    [`${base}?state=draft`]: listHtml({ owner, repo, state: 'draft', ids: [unread] }),
    [`${base}/${read}`]: detailHtml(read, 'Triage'),
  });

  await table.render(doc);
  const summary = await table.refresh(doc, {
    storage,
    fetch: fetch.send,
    wait: advance,
    href: `https://github.com${base}?state=triage`,
  });

  assert.ok(
    summary !== null && summary.read.failed.length === 1,
    'the missing page was read'
  );
  assert.strictEqual(progressText(doc), null, 'the header still said a refresh was running');
});

test('the chip the header carries is dimmed and says nothing with nothing left', () => {
  const doc = pageOf('<div id="advisories"></div>');
  const walking = table.progressChip(doc, { phase: 'walking', left: 0 });
  assert.ok(walking !== null, 'the walk said nothing');
  assert.strictEqual(
    walking.className,
    'Label Label--secondary bghsa-list-progress',
    `the chip carried ${walking.className}`
  );
  assert.strictEqual(walking.textContent, 'Loading...', 'the walk chip read otherwise');
  assert.strictEqual(
    table.progressChip(doc, { phase: 'reading', left: 0 }),
    null,
    'a pass with nothing left to read still said something'
  );
  assert.strictEqual(table.progressChip(doc, null), null, 'a document with no refresh said something');
});

test('a refresh crawls both open states and fills every row in', async () => {
  const owner = 'crawl-union';
  const repo = 'repo';
  const base = `/${owner}/${repo}/security/advisories`;
  const triage = 'GHSA-aaaa-aaaa-aaaa';
  const draft = 'GHSA-bbbb-bbbb-bbbb';
  const doc = pageOf(listHtml({ owner, repo, state: 'triage', ids: [triage] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const fetch = fakeFetch({
    [`${base}?state=draft`]: listHtml({ owner, repo, state: 'draft', ids: [draft] }),
    [`${base}/${triage}`]: detailHtml(triage, 'Triage'),
    [`${base}/${draft}`]: detailHtml(draft, 'Draft'),
  });

  const started = clockAt;
  try {
    await table.render(doc);
    assert.ok(tableRows(doc).length === 1, 'the first paint showed more than the page carried');

    const summary = await table.refresh(doc, {
      storage,
      fetch: fetch.send,
      wait: advance,
      href: `https://github.com${base}?state=triage`,
    });

    assert.deepStrictEqual(fetch.urls, [
      `${base}?state=draft`,
      `${base}/${triage}`,
      `${base}/${draft}`,
    ]);
    assert.ok(summary !== null && summary.read.fetched === 2, 'both advisories were not read');

    const rows = tableRows(doc);
    assert.ok(rows.length === 2, `rows after the refresh: ${rows.length}`);
    const ids = rows.map((row) => row.getAttribute('data-bghsa-ghsa')).sort();
    assert.deepStrictEqual(ids, [triage, draft].sort());
    const chips = new Map(rows.map((row) => [row.getAttribute('data-bghsa-ghsa'), chipLine(row)]));
    assert.ok(
      chips.get(triage) === 'Never reviewed[Label--secondary bghsa-tone-danger] |' +
      ' High, unconfirmed[Label--secondary bghsa-dim]',
      `the triage row after the refresh: ${chips.get(triage)}`
    );
    assert.ok(
      chips.get(draft) ===
        'Blocked on us[Label--secondary bghsa-tone-danger] |' +
          ' No patch yet[Label--secondary bghsa-tone-danger] |' +
          ' High, unconfirmed[Label--secondary bghsa-dim]',
      `the draft row after the refresh: ${chips.get(draft)}`
    );
  } finally {
    clockAt = started;
  }
});

test('an advisory observed four minutes ago is not read again', async () => {
  const owner = 'crawl-fresh';
  const repo = 'repo';
  const base = `/${owner}/${repo}/security/advisories`;
  const fresh = 'GHSA-aaaa-aaaa-aaaa';
  const stale = 'GHSA-bbbb-bbbb-bbbb';
  const doc = pageOf(listHtml({ owner, repo, state: 'triage', ids: [fresh, stale] }));
  const storage = fakeStorage();
  cache.setStorage(storage);
  const started = clockAt;
  try {
    await cache.putAdvisory(
      { owner, repo, ghsaId: fresh },
      { state: 'Triage', comments: [], timeline: [] },
      { storage, at: clockAt - 4 * MINUTE }
    );
    await cache.putAdvisory(
      { owner, repo, ghsaId: stale },
      { state: 'Triage', comments: [], timeline: [] },
      { storage, at: clockAt - 6 * MINUTE }
    );
    const fetch = fakeFetch({
      [`${base}?state=draft`]: listHtml({ owner, repo, state: 'draft', ids: [] }),
      [`${base}/${stale}`]: detailHtml(stale, 'Triage'),
    });

    const summary = await table.refresh(doc, {
      storage,
      fetch: fetch.send,
      wait: advance,
      href: `${base}?state=triage`,
    });

    assert.deepStrictEqual(fetch.urls, [`${base}?state=draft`, `${base}/${stale}`]);
    assert.ok(summary !== null && summary.read.skipped === 1, 'the fresh advisory was not skipped');
  } finally {
    clockAt = started;
  }
});

/**
 * Wait for the observer, render loop, or refresh to reach the expected state.
 *
 * @param {string} what The expected action, for the failure message.
 * @param {() => boolean} done
 * @returns {Promise<void>}
 */
async function until(what, done) {
  for (let round = 0; round < 400; round += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the surface never ${what}`);
}

/** @returns {Promise<void>} Waits through 20 event-loop turns of at least 5 ms. */
async function quiet() {
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a soft navigation to another repository crawls that repository', async () => {
  const alpha = { owner: 'soft-nav-alpha', repo: 'repo' };
  const beta = { owner: 'soft-nav-beta', repo: 'repo' };
  const alphaBase = `/${alpha.owner}/${alpha.repo}/security/advisories`;
  const betaBase = `/${beta.owner}/${beta.repo}/security/advisories`;
  const alphaId = 'GHSA-aaaa-aaaa-aaaa';
  const betaId = 'GHSA-cccc-cccc-cccc';
  const alphaList = listHtml({ ...alpha, state: 'triage', ids: [alphaId] });
  const betaList = listHtml({ ...beta, state: 'triage', ids: [betaId] });

  /** @type {Record<string, string>} */
  const pages = {
    [`${alphaBase}?state=triage`]: alphaList,
    [`${alphaBase}?state=draft`]: listHtml({ ...alpha, state: 'draft', ids: [] }),
    [`${alphaBase}/${alphaId}`]: detailHtml(alphaId, 'Triage'),
    [`${betaBase}?state=triage`]: betaList,
    [`${betaBase}?state=draft`]: listHtml({ ...beta, state: 'draft', ids: [] }),
    [`${betaBase}/${betaId}`]: detailHtml(betaId, 'Triage'),
  };
  /** @type {string[]} */
  const urls = [];
  /** @type {() => void} */
  let release = () => {};
  const holding = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    const asked = String(url);
    urls.push(asked);
    if (asked === `${alphaBase}/${alphaId}`) await holding;
    const body = pages[asked];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  };

  const doc = pageOf(alphaList);
  const storage = fakeStorage();
  cache.setStorage(storage);
  const started = clockAt;
  /** @type {MutationObserver | null} */
  let observer = null;
  try {
    const pass = table.passFor(doc, { storage, fetch: send, wait: advance });
    observer = table.observe(doc, pass);
    assert.ok(observer !== null, 'the document offered nothing to watch');
    await pass();
    await until('crawled the repository it opened on', () => urls.length === 3);
    assert.deepStrictEqual(urls, [
      `${alphaBase}?state=triage`,
      `${alphaBase}?state=draft`,
      `${alphaBase}/${alphaId}`,
    ]);

    one(doc, '#repo-content-turbo-frame').innerHTML = betaList;

    await until('crawled the repository it navigated to', () => urls.length === 6);
    assert.deepStrictEqual(urls.slice(3), [
      `${betaBase}?state=triage`,
      `${betaBase}?state=draft`,
      `${betaBase}/${betaId}`,
    ]);

    release();
    await until('filled the row it read', () => {
      const drawn = tableRows(doc);
      return drawn.length === 1 && chipLine(/** @type {Element} */ (drawn[0])) !== '';
    });
    await quiet();
    const rows = tableRows(doc);
    assert.deepStrictEqual(
      rows.map((row) => row.getAttribute('data-bghsa-ghsa')),
      [betaId],
      'the table held an advisory from the repository the page left'
    );
    const chips = chipLine(/** @type {Element} */ (rows[0]));
    assert.ok(chips === 'Never reviewed[Label--secondary bghsa-tone-danger] |' +
      ' High, unconfirmed[Label--secondary bghsa-dim]', `chips: ${chips}`);
  } finally {
    release();
    observer?.disconnect();
    clockAt = started;
  }
});

test('a list page reached again refreshes once the threshold has passed', async () => {
  const ref = { owner: 'soft-nav-back', repo: 'repo' };
  const base = `/${ref.owner}/${ref.repo}/security/advisories`;
  const ghsaId = 'GHSA-aaaa-aaaa-aaaa';
  const second = `${base}?state=triage&page=2`;
  const list = listHtml({ ...ref, state: 'triage', ids: [ghsaId], next: second });
  // Page two returns an error. An incomplete crawl makes a repeated refresh observable.
  const walked = [`${base}?state=triage`, second, `${base}?state=draft`, `${base}/${ghsaId}`];

  const doc = pageOf(list);
  const storage = fakeStorage();
  cache.setStorage(storage);
  const fetch = fakeFetch({
    [`${base}?state=triage`]: list,
    [`${base}?state=draft`]: listHtml({ ...ref, state: 'draft', ids: [] }),
    [`${base}/${ghsaId}`]: detailHtml(ghsaId, 'Triage'),
  });

  const started = clockAt;
  /** @type {MutationObserver | null} */
  let observer = null;
  try {
    const pass = table.passFor(doc, { storage, fetch: fetch.send, wait: advance });
    observer = table.observe(doc, pass);
    await pass();
    await until('crawled the repository it opened on', () => fetch.urls.length === 4);
    assert.deepStrictEqual(fetch.urls, walked);

    const frame = one(doc, '#repo-content-turbo-frame');
    for (const round of [1, 2]) {
      frame.innerHTML = '<div id="show_dialog"></div>';
      await until(`took the table away, round ${round}`, () => {
        return doc.getElementById(table.ROOT_ID) === null;
      });
      frame.innerHTML = list;
      await until(`put the table back, round ${round}`, () => {
        return doc.getElementById(table.ROOT_ID) !== null;
      });
      await quiet();
      assert.deepStrictEqual(
        fetch.urls,
        walked,
        `coming back inside the threshold spent a request, round ${round}`
      );
    }

    clockAt += 6 * MINUTE;
    frame.innerHTML = '<div id="show_dialog"></div>';
    await until('took the table away again', () => doc.getElementById(table.ROOT_ID) === null);
    frame.innerHTML = list;

    await until('crawled the repository again', () => fetch.urls.length === 7);
    assert.deepStrictEqual(fetch.urls.slice(4), [
      second,
      `${base}?state=draft`,
      `${base}/${ghsaId}`,
    ]);
  } finally {
    observer?.disconnect();
    clockAt = started;
  }
});

test('a pass stops when the page it is reading for goes to another repository', async () => {
  const alpha = { owner: 'stop-alpha', repo: 'repo' };
  const beta = { owner: 'stop-beta', repo: 'repo' };
  const alphaBase = `/${alpha.owner}/${alpha.repo}/security/advisories`;
  const betaBase = `/${beta.owner}/${beta.repo}/security/advisories`;
  const first = 'GHSA-aaaa-aaaa-aaaa';
  const second = 'GHSA-bbbb-bbbb-bbbb';
  const betaId = 'GHSA-cccc-cccc-cccc';
  const alphaList = listHtml({ ...alpha, state: 'triage', ids: [first, second] });
  const betaList = listHtml({ ...beta, state: 'triage', ids: [betaId] });

  /** @type {Record<string, string>} */
  const pages = {
    [`${alphaBase}?state=triage`]: alphaList,
    [`${alphaBase}?state=draft`]: listHtml({ ...alpha, state: 'draft', ids: [] }),
    [`${alphaBase}/${first}`]: detailHtml(first, 'Triage'),
    [`${alphaBase}/${second}`]: detailHtml(second, 'Triage'),
    [`${betaBase}?state=triage`]: betaList,
    [`${betaBase}?state=draft`]: listHtml({ ...beta, state: 'draft', ids: [] }),
    [`${betaBase}/${betaId}`]: detailHtml(betaId, 'Triage'),
  };
  /** @type {string[]} */
  const urls = [];
  /** @type {() => void} */
  let release = () => {};
  const holding = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    const asked = String(url);
    urls.push(asked);
    if (asked === `${alphaBase}/${first}`) await holding;
    const body = pages[asked];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  };

  const doc = pageOf(alphaList);
  const storage = fakeStorage();
  cache.setStorage(storage);
  const started = clockAt;
  /** @type {MutationObserver | null} */
  let observer = null;
  try {
    const pass = table.passFor(doc, { storage, fetch: send, wait: advance });
    observer = table.observe(doc, pass);
    await pass();
    await until('asked for the first advisory', () => urls.length === 3);

    one(doc, '#repo-content-turbo-frame').innerHTML = betaList;
    await until('crawled the repository it navigated to', () => urls.length === 6);

    release();
    await quiet();
    assert.deepStrictEqual(
      urls.filter((asked) => asked.startsWith(alphaBase)),
      [`${alphaBase}?state=triage`, `${alphaBase}?state=draft`, `${alphaBase}/${first}`],
      'the repository the page left went on spending requests'
    );
    assert.deepStrictEqual(
      urls.filter((asked) => asked.startsWith(betaBase)),
      [`${betaBase}?state=triage`, `${betaBase}?state=draft`, `${betaBase}/${betaId}`],
      'the repository the page went to was not read through'
    );
    const progress = await cache.getProgress(alpha, { storage, at: clockAt });
    const held = fetchQueue.progressFrom(progress);
    assert.deepStrictEqual(held === null ? null : held.pending, [second]);
    assert.deepStrictEqual(held === null ? null : held.done, [first]);
  } finally {
    release();
    observer?.disconnect();
    clockAt = started;
  }
});

test('a page left and come straight back to takes its pass back', async () => {
  const ref = { owner: 'stop-and-back', repo: 'repo' };
  const base = `/${ref.owner}/${ref.repo}/security/advisories`;
  const first = 'GHSA-aaaa-aaaa-aaaa';
  const second = 'GHSA-bbbb-bbbb-bbbb';
  const page2 = `${base}?state=triage&page=2`;
  const list = listHtml({ ...ref, state: 'triage', ids: [first, second], next: page2 });
  // The interrupted refresh leaves both a pending crawl page and an unread advisory.
  const walked = [`${base}?state=triage`, page2, `${base}?state=draft`];

  /** @type {Record<string, string>} */
  const pages = {
    [`${base}?state=triage`]: list,
    [`${base}?state=draft`]: listHtml({ ...ref, state: 'draft', ids: [] }),
    [`${base}/${first}`]: detailHtml(first, 'Triage'),
    [`${base}/${second}`]: detailHtml(second, 'Triage'),
  };
  /** @type {string[]} */
  const urls = [];
  /** @type {() => void} */
  let release = () => {};
  const holding = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    const asked = String(url);
    urls.push(asked);
    if (asked === `${base}/${first}`) await holding;
    const body = pages[asked];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  };

  const doc = pageOf(list);
  const storage = fakeStorage();
  cache.setStorage(storage);
  const started = clockAt;
  /** @type {MutationObserver | null} */
  let observer = null;
  try {
    const pass = table.passFor(doc, { storage, fetch: send, wait: advance });
    observer = table.observe(doc, pass);
    await pass();
    await until('asked for the first advisory', () => urls.length === 4);

    const frame = one(doc, '#repo-content-turbo-frame');
    frame.innerHTML = '<div id="show_dialog"></div>';
    assert.ok(doc.getElementById(table.ROOT_ID) === null, 'the table went with the frame');
    await quiet();
    release();
    await quiet();
    assert.deepStrictEqual(
      urls,
      [...walked, `${base}/${first}`],
      'the pass went on reading a repository the page had left'
    );

    frame.innerHTML = list;
    await until('read the advisory the pass had left', () => urls.length === 6);
    await quiet();
    assert.deepStrictEqual(
      urls.slice(4),
      [page2, `${base}/${second}`],
      'coming back read something other than what was left'
    );

    await until('filled both rows', () => {
      const drawn = tableRows(doc);
      return drawn.length === 2 && drawn.every((row) => chipLine(row) !== '');
    });
  } finally {
    release();
    observer?.disconnect();
    clockAt = started;
  }
});


test('the surface puts the table on the document it is given', async () => {
  const ref = { owner: 'soft-nav-start', repo: 'repo' };
  const ghsaId = 'GHSA-aaaa-aaaa-aaaa';
  const doc = pageOf(listHtml({ ...ref, state: 'triage', ids: [ghsaId] }));
  const storage = fakeStorage();

  /**
   * @returns {import('../src/common/crawl.js').StateWalk} A freshly completed crawl.
   */
  const finished = () => ({
    next: null,
    started: true,
    complete: true,
    startedAt: clockAt,
    completedAt: clockAt,
    pages: 1,
    failures: 0,
    stalled: false,
    abandonedAt: 0,
  });
  await cache.putList(
    ref,
    { walks: { triage: finished(), draft: finished() }, rows: {} },
    { storage, at: clockAt }
  );
  await cache.putAdvisory(
    { ...ref, ghsaId },
    { state: 'Triage', comments: [], timeline: [] },
    { storage, at: clockAt }
  );
  cache.setStorage(storage);

  /** @type {string[]} */
  const sent = [];
  const held = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (/** @type {unknown} */ url) => {
      sent.push(String(url));
      throw new Error('the surface sent a request');
    },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: doc });
  /** @type {MutationObserver | null} */
  let observer = null;
  try {
    observer = table.start();
    assert.ok(observer !== null, 'the surface watched nothing');
    await until('put the table on the page', () => doc.getElementById(table.ROOT_ID) !== null);
    await quiet();
    assert.deepStrictEqual(sent, [], 'a surface holding fresh data sent a request');
    assert.deepStrictEqual(
      tableRows(doc).map((row) => row.getAttribute('data-bghsa-ghsa')),
      [ghsaId]
    );
  } finally {
    observer?.disconnect();
    // @ts-expect-error the global is put back the way it was found.
    delete globalThis.document;
    if (held === undefined) {
      // @ts-expect-error as above.
      delete globalThis.fetch;
    } else {
      Object.defineProperty(globalThis, 'fetch', held);
    }
  }
});

test('one repository has one refresh queue', () => {
  const first = table.queueFor({ owner: 'crawl-one', repo: 'repo' });
  const again = table.queueFor({ owner: 'crawl-one', repo: 'repo' });
  assert.ok(first === again, 'a second queue was made for one repository');
  // Repository names are case-insensitive. Both spellings must share one rate limit.
  const spelled = table.queueFor({ owner: 'Crawl-One', repo: 'Repo' });
  assert.ok(spelled === first, 'another spelling of one repository made a second queue');
  const other = table.queueFor({ owner: 'crawl-two', repo: 'repo' });
  assert.ok(other !== first, 'two repositories shared one queue');
});

/**
 * @param {string} ghsaId
 * @param {Partial<import('../src/list/table.js').TableRow>} [changes]
 * @returns {import('../src/list/table.js').TableRow} A row with default list values and the supplied overrides.
 */
function sortRow(ghsaId, changes = {}) {
  return { ...table.unreadRow(listRow(ghsaId, '2026-08-01T00:00:00Z'), AT), ...changes };
}

/**
 * @param {readonly import('../src/list/table.js').TableRow[]} rows
 * @param {string} sort
 * @param {Record<string, string>} [filters]
 * @returns {string} the identifiers the view shows, in the order it shows them.
 */
function viewOrder(rows, sort, filters = {}) {
  return table
    .applyView(rows, { sort, filters })
    .map((row) => row.ghsaId ?? '')
    .join(' ');
}

/**
 * Each case expects C, A, B from input A, B, C.
 * The selected sort key must override input and identifier order.
 *
 * @type {readonly { sort: string, what: string, rows: import('../src/list/table.js').TableRow[] }[]}
 */
const SORT_CASES = [
  {
    sort: 'waiting',
    what: 'longest waiting first, and a wait that went unread last',
    rows: [
      sortRow('A', { waitingSince: '2026-08-20T00:00:00Z' }),
      sortRow('B', { waitingSince: null }),
      sortRow('C', { waitingSince: '2026-06-01T00:00:00Z' }),
    ],
  },
  {
    sort: 'severity',
    what: 'every confirmed severity above every unconfirmed one',
    rows: [
      sortRow('A', { severity: 'critical', severityLabel: 'Critical' }),
      sortRow('B', {}),
      sortRow('C', { severity: 'low', severityLabel: 'Low', severityConfirmed: true }),
    ],
  },
];

test('every sort key orders by the value it names', () => {
  const covered = SORT_CASES.map((each) => each.sort).sort();
  const keys = table.SORTS.filter((each) => each.compare !== null)
    .map((each) => each.key)
    .sort();
  assert.deepStrictEqual(covered, keys, 'a sort with no case');

  for (const each of SORT_CASES) {
    const got = viewOrder(each.rows, each.sort);
    assert.ok(got === 'C A B', `${each.sort}, ${each.what}: ${got}`);
  }
});

test('a filter and a sort the list no longer carries are gone', () => {
  const facets = table.FACETS.map((each) => each.key);
  const sorts = table.SORTS.map((each) => each.key);
  // REQUIREMENTS.md section 9 names seven filters and three sorts.
  assert.deepStrictEqual(facets, [
    'waiting',
    'severity',
    'owner',
    'state',
    'patch',
    'backports',
    'embargo',
  ]);
  assert.deepStrictEqual(sorts, [table.DEFAULT_SORT, 'severity', 'waiting']);

  assert.strictEqual(table.facetFor('cve'), null, 'the CVE facet is still here');
  const row = sortRow('A', { read: true, cve: 'CVE-2026-0001' });
  assert.strictEqual(
    table.applyView([row], { sort: table.DEFAULT_SORT, filters: { cve: 'Assigned' } }).length,
    1,
    'a filter over the cut CVE facet still holds the table'
  );

  const titled = [sortRow('A', { title: 'Zoe' }), sortRow('B', { title: 'Ada' })];
  assert.strictEqual(table.sortFor('title'), null, 'the title comparator is still here');
  assert.strictEqual(viewOrder(titled, 'title'), 'A B', 'a cut sort key still orders the table');
});

test('returning to the default order undoes a sort and a filter', () => {
  const rows = [
    sortRow('A', { read: true, triage: 'awaiting reporter', waitingSince: '2026-08-20T00:00:00Z' }),
    sortRow('B', {
      read: true,
      neverReviewed: true,
      triage: 'awaiting reporter',
      waitingSince: '2026-08-24T00:00:00Z',
    }),
    sortRow('C', { read: true, triage: 'evaluating', waitingSince: '2026-08-22T00:00:00Z' }),
  ];
  const picked = viewOrder(rows, 'waiting', { waiting: 'Blocked on us' });
  assert.ok(picked === 'C', `a sort and a filter together: ${picked}`);
  const back = table.applyView(rows, table.defaultViewState()).map((row) => row.ghsaId).join(' ');
  assert.ok(back === 'C B A', `the default order after picking another: ${back}`);
});

test('a filter on a value some rows do not have keeps only those that do', () => {
  const rows = [
    sortRow('A', { read: true, severity: 'high', severityLabel: 'High' }),
    sortRow('B', { read: true }),
    sortRow('C', { read: true, severity: 'low', severityLabel: 'Low' }),
  ];
  const high = viewOrder(rows, table.DEFAULT_SORT, { severity: 'High' });
  assert.ok(high === 'A', `the rows carrying a high severity: ${high}`);
  const none = viewOrder(rows, table.DEFAULT_SORT, { severity: table.NO_VALUE });
  assert.ok(none === 'B', `the rows a read left with no severity: ${none}`);
});

/**
 * @param {string} key
 * @returns {import('../src/list/table.js').Facet<import('../src/list/table.js').TableRow>}
 */
function facet(key) {
  const found = table.facetFor(key);
  if (found === null) throw new Error(`no facet named ${key}`);
  return found;
}

test('a filter offers the values the rows hold, in the order they belong in', () => {
  const rows = [
    sortRow('A', { read: true, severity: 'low', severityLabel: 'Low' }),
    sortRow('B', { read: true, severity: 'critical', severityLabel: 'Critical' }),
    sortRow('C', { read: true, severity: 'high', severityLabel: 'High' }),
    sortRow('D', { read: true, severity: 'moderate', severityLabel: 'Moderate' }),
  ];
  const offered = table.filterOptions(rows, facet('severity'), '').join(' ');
  assert.ok(
    offered === 'Critical High Moderate Low',
    `severity is offered by rank, not alphabetically: ${offered}`
  );

  const withNone = table.filterOptions([...rows, sortRow('E', { read: true })], facet('severity'), '');
  assert.ok(
    withNone.join(' ') === `Critical High Moderate Low ${table.NO_VALUE}`,
    `a read row holding no severity: ${withNone.join(' ')}`
  );

  const unread = table.filterOptions([...rows, sortRow('E')], facet('severity'), '');
  assert.ok(unread.join(' ') === 'Critical High Moderate Low', `an unread row: ${unread.join(' ')}`);

  const logins = [
    sortRow('A', { read: true, owners: ['zoe'] }),
    sortRow('B', { read: true, owners: ['ada'] }),
  ];
  const byName = table.filterOptions(logins, facet('owner'), '').join(' ');
  assert.ok(byName === 'ada zoe', `owners are offered alphabetically: ${byName}`);
});

test('a value a filter is holding to stays on offer after the last row carrying it leaves', () => {
  const rows = [sortRow('A', { read: true, owners: ['ada'] })];
  const offered = table.filterOptions(rows, facet('owner'), 'zoe').join(' ');
  assert.ok(offered === 'ada zoe', `the filtered value is still offered: ${offered}`);
});

/**
 * Repeat each combination of sort values under two different identifiers
 * to exercise identifier tie-breaking. IDs descend as rows are generated.
 *
 * @returns {import('../src/list/table.js').TableRow[]}
 */
function viewGrid() {
  const scores = [
    { severity: null, severityLabel: null, severityConfirmed: false },
    { severity: 'critical', severityLabel: 'Critical', severityConfirmed: false },
    { severity: 'low', severityLabel: 'Low', severityConfirmed: true },
  ];
  const waits = [null, '2026-01-01T00:00:00Z', '2026-08-01T00:00:00Z', '2020-06-01T00:00:00Z'];
  const states = ['Triage', 'Draft', null];
  const tiers = [
    { neverReviewed: true, newActivity: false, triage: null, embargoOverdue: false },
    { neverReviewed: false, newActivity: true, triage: null, embargoOverdue: false },
    { neverReviewed: false, newActivity: false, triage: 'evaluating', embargoOverdue: false },
    { neverReviewed: false, newActivity: false, triage: 'awaiting reporter', embargoOverdue: true },
  ];

  const size = 24;
  /** @type {import('../src/list/table.js').TableRow[]} */
  const rows = [];
  for (let i = 0; i < size; i += 1) {
    const at = /** @type {<T>(list: readonly T[]) => T} */ (
      (list) => /** @type {any} */ (list[i % list.length])
    );
    rows.push(
      sortRow(`GHSA-${String(size - i).padStart(4, '0')}`, {
        read: true,
        waitingSince: at(waits),
        state: at(states),
        ...at(scores),
        ...at(tiers),
      })
    );
  }
  return rows;
}

/**
 * @param {(a: import('../src/list/table.js').TableRow, b: import('../src/list/table.js').TableRow) => number} compare
 * @param {readonly import('../src/list/table.js').TableRow[]} rows
 * @param {string} what
 */
function isTotalOrder(compare, rows, what) {
  for (const a of rows) {
    assert.ok(compare(a, a) === 0, `${what}: ${a.ghsaId} against itself`);
    for (const b of rows) {
      const forward = Math.sign(compare(a, b));
      const back = Math.sign(compare(b, a));
      assert.ok(forward === -back, `${what}: ${a.ghsaId} and ${b.ghsaId} disagree on which comes first`);
      if (a !== b) assert.ok(forward !== 0, `${what}: ${a.ghsaId} and ${b.ghsaId} are distinct but tie`);
    }
  }
  for (const a of rows) {
    for (const b of rows) {
      if (compare(a, b) > 0) continue;
      for (const c of rows) {
        if (compare(b, c) > 0) continue;
        assert.ok(
          compare(a, c) <= 0,
          `${what}: ${a.ghsaId} before ${b.ghsaId} before ${c.ghsaId} does not carry through`
        );
      }
    }
  }
}

test('every sort is a total order over a grid of the values it branches on', () => {
  const rows = viewGrid();
  assert.ok(rows.length === 24, `grid size: ${rows.length}`);
  const held = new Set(rows.map((row) => row.ghsaId));
  assert.ok(held.size === rows.length, 'the grid holds one identifier twice');
  for (const each of table.SORTS) {
    const compare = table.sortFor(each.key);
    if (each.compare === null) {
      assert.ok(compare === null, 'the default order is a sort key among others');
      continue;
    }
    if (compare === null) throw new Error(`${each.key} runs no comparator`);
    isTotalOrder(compare, rows, each.key);
  }
});

test('a sort does not depend on the order the rows arrived in', () => {
  const rows = viewGrid();
  let seed = 12345;
  /** @returns {import('../src/list/table.js').TableRow[]} */
  const shuffle = () => {
    const shuffled = rows.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      const swap = /** @type {import('../src/list/table.js').TableRow} */ (shuffled[i]);
      shuffled[i] = /** @type {import('../src/list/table.js').TableRow} */ (shuffled[j]);
      shuffled[j] = swap;
    }
    return shuffled;
  };

  for (const each of table.SORTS.map((sort) => sort.key)) {
    const wanted = viewOrder(rows, each);
    for (let round = 0; round < 5; round += 1) {
      const got = viewOrder(shuffle(), each);
      assert.ok(got === wanted, `${each}, shuffle ${round}, differs from the order of the grid`);
    }
    assert.ok(viewOrder(table.applyView(rows, { sort: each, filters: {} }), each) === wanted,
      `${each}: a second pass moved something`);
  }
});

test('a row whose identifier went unread sorts last under every sort', () => {
  // Both default and selected sorts must place missing identifiers last.
  const unread = sortRow('GHSA-aaaa-aaaa-aaaa', {
    ghsaId: null,
    waitingSince: '2026-08-01T00:00:00Z',
  });
  const known = sortRow('GHSA-aaaa-aaaa-aaaa', { waitingSince: '2026-08-01T00:00:00Z' });
  const waiting = table.applyView([unread, known], { sort: 'waiting', filters: {} });
  assert.ok(waiting[0] === known, 'the waiting sort put the unread identifier first');
  const byDefault = table.applyView([unread, known], table.defaultViewState());
  assert.ok(byDefault[0] === known, 'the default order put the unread identifier first');
});

test('sorting and filtering leave the rows the table holds alone', () => {
  const rows = [
    sortRow('B', { read: true, waitingSince: '2026-08-01T00:00:00Z' }),
    sortRow('A', { read: true, waitingSince: '2026-01-01T00:00:00Z' }),
  ];
  table.applyView(rows, { sort: 'waiting', filters: { owner: table.NO_VALUE } });
  assert.ok(rows[0]?.ghsaId === 'B', 'the array the table holds was reordered');
  assert.ok(rows.length === 2, 'the array the table holds lost a row');
});

/**
 * @param {import('../src/list/table.js').TableRow} row
 * @returns {string} The facet values as one line.
 */
function facetLine(row) {
  return table.FACETS.map((each) => `${each.key}=${each.valuesOf(row).join('+')}`).join(' ');
}

test('every filter reads the fixture the cache holds', async () => {
  const parsed = parseList.parseList(listPage('list-page-triage.html'));
  if (parsed === null) throw new Error('the fixture is not a list page');
  const source = parsed.rows[0];
  if (source === undefined) throw new Error('the fixture carries no row');

  const read = await table.viewRow({ row: source, seenAt: AT }, entryOf(TRIAGE_RECORD, 'triage'), AT);
  assert.ok(
    facetLine(read) ===
      'waiting=Blocked on the reporter severity=High owner=samuelkarp state=Triage' +
        ' patch= backports=Complete embargo=In force',
    `the facets of the cached triage read: ${facetLine(read)}`
  );

  const unread = table.unreadRow(source, AT);
  assert.ok(
    facetLine(unread) ===
      'waiting= severity=High owner= state=Triage patch= backports= embargo=',
    `the facets before a read: ${facetLine(unread)}`
  );
  for (const each of table.FACETS) {
    const held = each.valuesOf(read);
    const wanted = held[0] ?? table.NO_VALUE;
    assert.ok(
      table.matchesFilter(each, unread, wanted),
      `${each.key}: a filter on ${wanted} hides the row before it is read`
    );
  }
});

/**
 * @param {Partial<import('../src/list/table.js').TableRow>} changes
 * @returns {string} The row's Patch filter value.
 */
function patchValueOf(changes) {
  const facet = table.FACETS.find((each) => each.key === 'patch');
  if (facet === undefined) throw new Error('the table offers no patch facet');
  return facet.valuesOf(rowWith(changes)).join('+');
}

test('the patch filter reads a draft row and no other', () => {
  assert.strictEqual(patchValueOf({ read: true, state: 'Draft', patch: 'Patch in review' }), 'In review');
  assert.strictEqual(patchValueOf({ read: true, state: 'Draft', patch: 'No patch yet' }), 'No patch');

  assert.strictEqual(patchValueOf({ read: true, state: 'Draft', patch: 'Unknown' }), '');

  for (const state of ['Triage', 'Published', 'Closed', null]) {
    assert.strictEqual(
      patchValueOf({ read: true, state, patch: 'Patch in review' }),
      '',
      `a ${state} advisory with an open pull request filters under a chip it does not show`
    );
    assert.strictEqual(patchValueOf({ read: true, state, patch: 'No patch yet' }), '');
  }

  assert.strictEqual(patchValueOf({ state: 'Draft', patch: null }), '');
});

/**
 * @param {Element} control The `details` a control is built on.
 * @returns {Element[]} the items its menu offers, in the order it offers them.
 */
function itemNodes(control) {
  return Array.from(control.querySelectorAll(`[${table.VALUE_ATTRIBUTE}]`));
}

/**
 * @param {Element} control
 * @param {string} value The selected value.
 * @returns {void}
 */
function press(control, value) {
  for (const item of itemNodes(control)) {
    if ((item.getAttribute(table.VALUE_ATTRIBUTE) ?? '') !== value) continue;
    /** @type {HTMLElement} */ (/** @type {unknown} */ (item)).click();
    return;
  }
  const named = value === '' ? 'item that holds it to nothing' : value;
  throw new Error(`the control offers no ${named}`);
}

/**
 * @param {Document} doc
 * @param {string} facet
 * @returns {Element} the control holding the table to one value of that facet.
 */
function filterIn(doc, facet) {
  for (const control of doc.querySelectorAll(`#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}]`)) {
    if (control.getAttribute(table.FACET_ATTRIBUTE) === facet) return control;
  }
  throw new Error(`the table offers no ${facet} filter`);
}

/**
 * @param {Element} control
 * @returns {string} The menu item labels as one line.
 */
function itemsOf(control) {
  return itemNodes(control)
    .map((item) => item.textContent ?? '')
    .join(' | ');
}

/**
 * @param {Element} control
 * @returns {string} The checked value, or the number checked if it differs from one.
 */
function checkedIn(control) {
  const held = itemNodes(control).filter((item) => item.getAttribute('aria-checked') === 'true');
  if (held.length !== 1) return `${held.length} items checked`;
  return held[0]?.getAttribute(table.VALUE_ATTRIBUTE) ?? '';
}

/**
 * @param {Document} doc
 * @returns {string} the identifiers the table is showing, in the order it shows
 *   them.
 */
function shownIds(doc) {
  return tableRows(doc)
    .map((row) => row.getAttribute('data-bghsa-ghsa') ?? '')
    .join(' ');
}

/**
 * @param {readonly import('../src/list/table.js').TableRow[]} rows
 * @returns {{ doc: Document, root: Element }}
 */
function tableOver(rows) {
  const doc = listPage('list-page-triage.html');
  cache.setStorage(fakeStorage());
  table.setViewState(doc, table.defaultViewState());
  /** @type {Map<string, import('../src/list/table.js').RowSource>} */
  const sources = new Map();
  for (const row of rows) {
    if (row.ghsaId === null) continue;
    sources.set(row.ghsaId, {
      row: listRow(row.ghsaId, '2026-08-01T00:00:00Z'),
      seenAt: AT,
    });
  }
  const root = table.injectTable(doc, { rows: rows.slice(), at: AT, sources });
  if (root === null) throw new Error('the page offered no anchor');
  return { doc, root };
}

test('the controls offer every value the table holds', async () => {
  const doc = listPage('list-page-triage.html');
  table.setViewState(doc, table.defaultViewState());
  await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(TRIAGE_RECORD, 'triage') });

  const sort = one(doc, `#${table.ROOT_ID} .bghsa-list-sort`);
  const offered = itemsOf(sort);
  const wanted = table.SORTS.map((each) => each.label).join(' | ');
  assert.ok(offered === wanted, `the sort offers: ${offered}`);
  assert.ok(
    offered === 'Default | Highest severity | Longest waiting',
    `the sort labels: ${offered}`
  );

  const filters = Array.from(doc.querySelectorAll(`#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}]`))
    .map((control) => control.getAttribute(table.FACET_ATTRIBUTE) ?? '')
    .join(' ');
  assert.ok(
    filters === 'waiting severity owner state patch backports embargo',
    `the filters offered: ${filters}`
  );

  assert.ok(
    itemsOf(filterIn(doc, 'owner')) === `${table.ANY_LABEL} | samuelkarp`,
    `the owner filter offers: ${itemsOf(filterIn(doc, 'owner'))}`
  );
  assert.ok(
    itemsOf(filterIn(doc, 'waiting')) === 'Any | Blocked on the reporter',
    `the waiting filter offers: ${itemsOf(filterIn(doc, 'waiting'))}`
  );

  const reset = one(doc, `#${table.ROOT_ID} .bghsa-list-reset`);
  assert.ok((reset.textContent ?? '') === table.RESET_LABEL, `the reset reads: ${reset.textContent}`);
});

/**
 * @returns {{ doc: Document, root: Element }}
 */
function ownedTable() {
  return tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', { read: true, owners: ['ada'] }),
    sortRow('GHSA-bbbb-bbbb-bbbb', { read: true, owners: ['zoe'] }),
  ]);
}

/**
 * @param {Document} doc
 * @param {string} facet
 * @returns {string} The filter summary text.
 */
function summaryOf(doc, facet) {
  return (
    one(doc, `#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}="${facet}"] > summary`).textContent ?? ''
  );
}

test('a filter menu says to a screen reader what it is and whether it is open', () => {
  const { doc } = ownedTable();
  const control = filterIn(doc, 'owner');

  // The native details element exposes its open state to assistive technology.
  assert.ok(control.tagName.toLowerCase() === 'details', `the control is a ${control.tagName}`);
  const box = one(doc, `#${table.ROOT_ID} .bghsa-list-controls`);
  assert.ok(box.querySelector('[aria-expanded]') === null, 'a control carries aria-expanded');

  const summary = one(doc, `#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}="owner"] > summary`);
  assert.ok(summary.getAttribute('role') === 'button', 'the summary does not say it is a button');
  assert.ok(
    summary.getAttribute('aria-haspopup') === 'menu',
    'the summary does not say it opens a menu'
  );

  const body = one(doc, `#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}="owner"] details-menu`);
  assert.ok(body.getAttribute('role') === 'menu', 'the menu does not say it is one');
  assert.ok(
    body.getAttribute('aria-label') === 'Owner',
    `the menu is labeled: ${body.getAttribute('aria-label')}`
  );

  for (const item of itemNodes(control)) {
    assert.ok(item.getAttribute('role') === 'menuitemradio', 'an item is not a menu item');
    assert.ok(item.hasAttribute('aria-checked'), 'an item does not say whether it is held');
  }
});

test('a menu marks the item the view is holding to, and marks no other', () => {
  const { doc } = ownedTable();
  assert.ok(checkedIn(filterIn(doc, 'owner')) === '', `a filter came up holding: ${checkedIn(filterIn(doc, 'owner'))}`);
  assert.ok(summaryOf(doc, 'owner') === 'Owner', `the summary reads: ${summaryOf(doc, 'owner')}`);

  press(filterIn(doc, 'owner'), 'ada');
  assert.ok(
    checkedIn(filterIn(doc, 'owner')) === 'ada',
    `the owner filter marks: ${checkedIn(filterIn(doc, 'owner'))}`
  );
  assert.ok(summaryOf(doc, 'owner') === 'Owner: ada', `the summary reads: ${summaryOf(doc, 'owner')}`);
  const sort = one(doc, `#${table.ROOT_ID} .bghsa-list-sort`);
  assert.ok(checkedIn(sort) === table.DEFAULT_SORT, `the sort marks: ${checkedIn(sort)}`);

  press(filterIn(doc, 'owner'), 'zoe');
  assert.ok(
    checkedIn(filterIn(doc, 'owner')) === 'zoe',
    `after a second press: ${checkedIn(filterIn(doc, 'owner'))}`
  );
});

test('pressing an item changes the view and navigates nowhere', () => {
  const { doc, root } = ownedTable();
  const box = one(doc, `#${table.ROOT_ID} .bghsa-list-controls`);
  assert.ok(box.querySelector('[href]') === null, 'a control would navigate');
  for (const item of box.querySelectorAll(`[${table.VALUE_ATTRIBUTE}]`)) {
    assert.ok(item.tagName.toLowerCase() === 'button', `an item is a ${item.tagName}`);
    assert.ok(item.getAttribute('type') === 'button', 'an item would submit the form it sits in');
  }

  press(filterIn(doc, 'owner'), 'ada');
  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa', `the rows ada owns: ${shownIds(doc)}`);
  assert.ok(doc.getElementById(table.ROOT_ID) === root, 'the whole table was rebuilt');

  press(filterIn(doc, 'owner'), '');
  assert.ok(
    shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa GHSA-bbbb-bbbb-bbbb',
    `the whole table is back: ${shownIds(doc)}`
  );
});

test('the button in a menu header closes it', () => {
  const { doc } = ownedTable();
  const control = filterIn(doc, 'owner');
  control.setAttribute('open', '');
  const close = one(doc, `#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}="owner"] .SelectMenu-closeButton`);
  assert.ok(
    (close.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '') === 'Close menu',
    'the close button says nothing about what it does'
  );
  /** @type {HTMLElement} */ (/** @type {unknown} */ (close)).click();
  assert.ok(!control.hasAttribute('open'), 'the menu stayed open');
});

test('a filter that keeps nothing says so', () => {
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', {
      read: true,
      owners: ['ada'],
      severity: 'high',
      severityLabel: 'High',
    }),
    sortRow('GHSA-bbbb-bbbb-bbbb', {
      read: true,
      owners: ['zoe'],
      severity: 'low',
      severityLabel: 'Low',
    }),
  ]);
  press(filterIn(doc, 'owner'), 'ada');
  press(filterIn(doc, 'severity'), 'Low');
  assert.ok(shownIds(doc) === '', `rows under a filter nothing matches: ${shownIds(doc)}`);
  const empty = textOf(doc, `#${table.ROOT_ID} .bghsa-list-empty`);
  assert.ok(empty === table.EMPTY_TEXT, `what stands in for the rows: ${empty}`);
  assert.ok(empty === 'No matches', `the wording: ${empty}`);
  const count = textOf(doc, `#${table.ROOT_ID} .bghsa-list-count`);
  assert.ok(count === '0 of 2 advisories', `the count: ${count}`);
});

test('a table holding no advisory at all says nothing about a filter', () => {
  const { doc } = tableOver([]);
  assert.ok(doc.querySelector(`#${table.ROOT_ID} .bghsa-list-empty`) === null, 'a filter was blamed');
  assert.ok(textOf(doc, `#${table.ROOT_ID} .bghsa-list-count`) === '0 advisories', 'the count');
});

/**
 * @param {Document} doc
 * @returns {boolean} whether the reset is offered.
 */
function resetPressable(doc) {
  return !one(doc, `#${table.ROOT_ID} .bghsa-list-reset`).hasAttribute('disabled');
}

test('the reset is offered only where there is something to reset', () => {
  const { doc } = ownedTable();
  assert.strictEqual(resetPressable(doc), false, 'the table came up filtered or sorted');

  press(filterIn(doc, 'owner'), 'ada');
  assert.strictEqual(resetPressable(doc), true, 'a filter is holding the table');

  press(filterIn(doc, 'owner'), '');
  assert.strictEqual(resetPressable(doc), false, 'the filter was put back');

  press(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'severity');
  assert.strictEqual(resetPressable(doc), true, 'a sort is holding the table');

  press(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), table.DEFAULT_SORT);
  assert.strictEqual(resetPressable(doc), false, 'the sort was put back');
});

test('the reset goes back to the default order and drops every filter', () => {
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', {
      read: true,
      owners: ['ada'],
      triage: 'evaluating',
      severity: 'low',
      severityLabel: 'Low',
    }),
    sortRow('GHSA-bbbb-bbbb-bbbb', {
      read: true,
      owners: ['zoe'],
      severity: 'critical',
      severityLabel: 'Critical',
    }),
  ]);
  press(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'severity');
  assert.ok(shownIds(doc) === 'GHSA-bbbb-bbbb-bbbb GHSA-aaaa-aaaa-aaaa', `sorted: ${shownIds(doc)}`);
  press(filterIn(doc, 'owner'), 'ada');
  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa', `sorted and filtered: ${shownIds(doc)}`);

  /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-list-reset`))
  ).click();

  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa GHSA-bbbb-bbbb-bbbb', `back to the default: ${shownIds(doc)}`);
  const sort = one(doc, `#${table.ROOT_ID} .bghsa-list-sort`);
  assert.ok(
    checkedIn(sort) === table.DEFAULT_SORT,
    `the sort control still names the sort that was: ${checkedIn(sort)}`
  );
  assert.ok(
    checkedIn(filterIn(doc, 'owner')) === '',
    `the owner filter still names the owner it was holding: ${checkedIn(filterIn(doc, 'owner'))}`
  );
});

test('a read landing leaves the sort and the filter a maintainer picked alone', async () => {
  const ghsaId = 'GHSA-bbbb-bbbb-bbbb';
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', {
      read: true,
      owners: ['ada'],
      triage: 'evaluating',
      waitingSince: '2026-08-20T00:00:00Z',
    }),
    sortRow(ghsaId, { waitingSince: '2026-01-01T00:00:00Z' }),
  ]);
  assert.ok(shownIds(doc) === `GHSA-aaaa-aaaa-aaaa ${ghsaId}`, `the default order: ${shownIds(doc)}`);
  press(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'waiting');
  press(filterIn(doc, 'owner'), 'ada');
  assert.ok(
    shownIds(doc) === `${ghsaId} GHSA-aaaa-aaaa-aaaa`,
    `by waiting under the owner filter: ${shownIds(doc)}`
  );

  const detail = parseDetail.parseDetail(
    /** @type {Document} */ (/** @type {unknown} */ (parseHTML(detailHtml(ghsaId, 'Triage')).document))
  );
  const applied = await table.applyEntry(doc, ghsaId, {
    record: detail,
    observedAt: AT - 30 * MINUTE,
    state: 'triage',
  });
  assert.ok(applied, 'no row was replaced');

  // Updating a row preserves its visibility and position until the next render.
  assert.ok(shownIds(doc) === `${ghsaId} GHSA-aaaa-aaaa-aaaa`, `after the read: ${shownIds(doc)}`);
  const row = /** @type {Element} */ (tableRows(doc)[0]);
  assert.ok(
    chipLine(row) === 'Never reviewed[Label--secondary bghsa-tone-danger] |' +
      ' High, unconfirmed[Label--secondary bghsa-dim]',
    `the row took the read in: ${chipLine(row)}`
  );
  assert.ok(
    itemsOf(filterIn(doc, 'severity')) === 'Any | High | None',
    `the severity filter after the read: ${itemsOf(filterIn(doc, 'severity'))}`
  );

  table.refreshBody(doc);
  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa', `once the table settles: ${shownIds(doc)}`);
});

test('a read for a row a filter is holding out of view still reaches the table', async () => {
  const ghsaId = 'GHSA-bbbb-bbbb-bbbb';
  const { doc } = tableOver([
    sortRow('GHSA-aaaa-aaaa-aaaa', { read: true, owners: ['ada'] }),
    sortRow(ghsaId, { read: true, owners: ['zoe'] }),
  ]);
  press(filterIn(doc, 'owner'), 'ada');
  assert.ok(shownIds(doc) === 'GHSA-aaaa-aaaa-aaaa', `under the owner filter: ${shownIds(doc)}`);

  const detail = parseDetail.parseDetail(
    /** @type {Document} */ (/** @type {unknown} */ (parseHTML(detailHtml(ghsaId, 'Triage')).document))
  );
  const applied = await table.applyEntry(doc, ghsaId, {
    record: detail,
    observedAt: AT - 30 * MINUTE,
    state: 'triage',
  });
  assert.ok(!applied, 'a row a filter is holding out of view was drawn');
  press(filterIn(doc, 'severity'), 'High');
  press(filterIn(doc, 'owner'), '');
  assert.ok(shownIds(doc) === ghsaId, `the row the read filled in: ${shownIds(doc)}`);
});

test('a re-render keeps the view a maintainer picked', async () => {
  const low = 'GHSA-aaaa-aaaa-aaaa';
  const high = 'GHSA-bbbb-bbbb-bbbb';
  const doc = pageOf(listHtml({ ...REF, state: 'triage', ids: [low, high] }));
  table.setViewState(doc, table.defaultViewState());
  /** @type {Record<string, unknown>} */
  const held = {
    [keyFor(low)]: entryOf(storedDetail(low, 'Draft', 'Low'), 'triage'),
    [keyFor(high)]: entryOf(storedDetail(high, 'Triage', 'High'), 'triage'),
  };
  await render(doc, held);
  assert.ok(shownIds(doc) === `${low} ${high}`, `the default order: ${shownIds(doc)}`);

  press(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'severity');
  assert.ok(shownIds(doc) === `${high} ${low}`, `the highest severity first: ${shownIds(doc)}`);
  press(filterIn(doc, 'severity'), 'Low');
  assert.ok(shownIds(doc) === low, `held to the low severity: ${shownIds(doc)}`);

  await render(doc, held);
  const sort = one(doc, `#${table.ROOT_ID} .bghsa-list-sort`);
  assert.ok(checkedIn(sort) === 'severity', 'the sort was lost when the table was drawn again');
  assert.ok(
    checkedIn(filterIn(doc, 'severity')) === 'Low',
    'the filter was lost when the table was drawn again'
  );
  assert.ok(shownIds(doc) === low, `the rows after the table was drawn again: ${shownIds(doc)}`);

  press(filterIn(doc, 'severity'), 'High');
  assert.ok(shownIds(doc) === high, `the row the filter keeps: ${shownIds(doc)}`);
});

test("the controls go out of view with the table, and the toggle stays", async () => {
  const doc = listPage('list-page-triage.html');
  table.setViewState(doc, table.defaultViewState());
  await render(doc);
  const controls = one(doc, `#${table.ROOT_ID} .bghsa-list-controls`);
  assert.ok(!controls.classList.contains(table.HIDDEN_CLASS), 'the controls came up hidden');

  toggleIn(doc).click();
  assert.ok(controls.classList.contains(table.HIDDEN_CLASS), "the controls stayed on GitHub's view");
  assert.ok(
    !one(doc, `#${table.ROOT_ID} .bghsa-list-toggle`).classList.contains(table.HIDDEN_CLASS),
    'the toggle went out of view with them'
  );

  toggleIn(doc).click();
  assert.ok(!controls.classList.contains(table.HIDDEN_CLASS), 'the controls did not come back');
});
