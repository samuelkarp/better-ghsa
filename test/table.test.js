'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');

const parseList = require('../src/common/parse-list.js');
const parseDetail = require('../src/common/parse-detail.js');
const cache = require('../src/common/cache.js');
const order = require('../src/common/order.js');
const table = require('../src/list/table.js');
const fetchQueue = require('../src/common/fetch.js');

const allowlist = require('../src/common/allowlist.js');

const { fakeStorage } = require('../test-support/storage.js');

// The list of repositories the extension acts on is stored rather than compiled
// in, and is empty on a fresh install. The fixtures here are that repository's,
// so the list is put in place and read before the first test, which is what the
// extension itself does before it takes a page.
test.before(async () => {
  allowlist.setStorage({
    get: async () => ({ [allowlist.STORAGE_KEY]: ['git-utensils/spoon-knife'] }),
    set: async () => {},
  });
  await allowlist.load();
});

/** The moment every render in this file reads the page at. */
const AT = Date.parse('2026-08-26T12:00:00Z');

/** The moment the cached advisory reads in this file were taken at. */
const OBSERVED = Date.parse('2026-08-26T10:00:00Z');

/**
 * The clock every render and every queue here reads. A refresh moves it, so it
 * is a variable rather than a constant, and a test that moves it puts it back.
 */
let clockAt = AT;

cache.setClock(() => clockAt);

// The queue and the crawl turn a fetched page into a document the way a content
// script does. Nothing in this file reaches the network: every response is a
// string a test wrote.
globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

const MINUTE = 60 * 1000;

/** The repository both list fixtures come from. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

/**
 * The page these tests run on. Every pass asks the gate whether the extension
 * runs here, and the gate reads the path. The documents below carry invented
 * repositories so that each one gets a refresh queue of its own, and what GitHub
 * has put in the frame is not what the path says: a soft navigation replaces the
 * frame's contents and the surface reads the repository off them.
 */
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
 * The list fixture inside the frame GitHub replaces on a soft navigation, which
 * is what the observer watches and what a re-render has to survive.
 *
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
 * One advisory as the cache holds it: a parsed detail page, put through JSON the
 * way `browser.storage.local` puts it.
 *
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

/** The one parse of each large fixture in this file. */
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
 * How one rendered chip is colored: every class on it other than `Label`, in
 * the order the chip carries them. A chip with nothing but `Label` answers
 * empty, which no chip the table draws does.
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
 * Every chip under one row's title, as one line. Each names in brackets exactly
 * which classes color it, so one string covers what the chips read and how each
 * one is painted, and a chip painted the wrong color fails rather than passing
 * on being painted at all.
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
 * @returns {string[]} what each cell beside the main column holds, in the order
 *   the row draws them. The main column is the first child, so the cells are
 *   what follows it.
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

  // GitHub paints this row's own severity chip `Label--orange`, and the table
  // reuses that class rather than deriving one from the word `high`. Nobody has
  // confirmed the scoring, so it is dimmed.
  const chips = chipLine(row);
  assert.ok(chips === 'High[Label--orange bghsa-dim]', `chips with nothing read: ${chips}`);

  // The list markup says when GitHub's row was seen, not when the advisory
  // behind it was read, and no advisory read backs this row.
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
  // An owner login arrives with no account id beside it, so the icon is asked
  // for by login. GitHub redirects that to the id-keyed avatar the captures
  // carry, at twice the drawn size.
  const src = avatar.getAttribute('src');
  assert.ok(
    src === 'https://github.com/samuelkarp.png?size=40',
    `owner avatar source: ${src}`
  );

  const observed = textOf(row, '.bghsa-list-observed');
  assert.ok(observed === 'Observed 2026-08-26 10:00 UTC', `observed: ${observed}`);
});

test('the cells beside a row are the owners, the state, and the observation', async () => {
  const doc = listPage('list-page-triage.html');
  await render(doc, { [keyFor('GHSA-jmvx-2wfw-xfgj')]: entryOf(TRIAGE_RECORD, 'triage') });

  // The completed list ends on the same two cells, so the state and the
  // observation stand in one place across both views.
  const row = /** @type {Element} */ (tableRows(doc)[0]);
  assert.deepStrictEqual(cellsOf(row), ['owners', 'state', 'observed']);
});

test('an owner login is encoded the same way in the link and the avatar', () => {
  const doc = /** @type {Document} */ (
    /** @type {unknown} */ (parseHTML('<!doctype html><html><body></body></html>').document)
  );
  // The login comes from a state comment, which is text anyone who can comment
  // on the advisory can write. It reaches the page twice from one string, so
  // both places encode it the same way.
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

/** One open pull request on the private fork, as a cached read holds it. */
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
 * @param {unknown} fork What its private fork holds.
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
  // Primer paints the classes GitHub's own chips carry. These are the
  // extension's own, so a chip carrying one and no rule defining it would draw
  // as though it carried no color at all.
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
  // Five renders, each differing from another in one thing: the state, what the
  // fork holds, and whether anything was read at all. The draft and the triage
  // advisory are rendered over the same open pull request, so a chip that read
  // the fork and ignored the state would show up here, and the draft is
  // rendered both with a patch and without, so one that read the state and
  // ignored the fork would too.
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

  // The same open pull request the draft above was painted for, on an advisory
  // in triage. No patch is owed until the advisory is accepted, so neither the
  // patch nor its absence puts a chip on the row.
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
    // Placed once the table is in the document, so a surface drawing into the
    // bar finds it.
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

    // Every view is reachable from every other: the surface gives way to
    // GitHub's view, and GitHub's view gives the table back.
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

  // A soft navigation replaces the frame contents, and the table goes with them.
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

  // The parser keys on these three inside `div#advisories`. The table carries
  // none of them, which is what keeps a re-read from taking its rows for
  // GitHub's own.
  const matched = root.querySelectorAll(table.PARSED_SELECTORS.join(', ')).length;
  assert.ok(matched === 0, `nodes in the table the parser would read: ${matched}`);
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

  // A stored value is read off the advisory's own page, so a row nothing has
  // been read on carries no waiting chip whatever it holds.
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

  // The two values a maintainer owes the next move on read apart, which is what
  // a row saying `Blocked on us` for both of them cannot do.
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

  // What the reporter did since the value was set is not in the value, so both
  // chips stand, the derivation first.
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

  // The confirmed case is the ordinary one, so the chip is the level alone,
  // filled with the color the level carries.
  const confirmed = chipsOf({ read: true, severityLabel: 'Low', severityConfirmed: true });
  assert.ok(
    confirmed === 'Blocked on us[danger] | Low[fill]',
    `severity a maintainer confirmed: ${confirmed}`
  );

  // With no severity set there is no chip, and the confirmation gets none of
  // its own: the panel is where a confirmation is read.
  const noSeverity = chipsOf({ read: true, severityConfirmed: true });
  assert.ok(noSeverity === 'Blocked on us[danger]', `no severity set: ${noSeverity}`);
});

test('the severity chip takes the class GitHub painted, not one off the level', () => {
  // The level is deliberately at odds with the class, which is a pairing no
  // level-to-color table would produce: GitHub paints critical one way and this
  // row carries the class it paints high with. What comes out is the class the
  // row carried, so the color is read off GitHub's chip and never derived.
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

  // A severity chip GitHub carried no modifier on leaves nothing to reuse, and
  // the extension paints nothing of its own in its place.
  const bare = chipsOf({ read: true, severityLabel: 'Critical', severityConfirmed: true });
  assert.ok(
    bare === 'Blocked on us[danger] | Critical[fill]',
    `no class on GitHub's chip: ${bare}`
  );
});

test('a confirmed severity is drawn filled and an unconfirmed one is not', () => {
  // One level and one color over two rows, so what differs between the chips
  // drawn can only be the confirmation.
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

  // A patch nobody has written and one under review are both where the work
  // stands, and part in how loud they are.
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

  // A pull request this reader could not judge leaves the fork holding one, so
  // the row says neither that a patch is under review nor that none exists.
  const unjudged = chipsOf({ ...draft, patch: 'Unknown' });
  assert.ok(unjudged === 'Blocked on us[danger] | Unknown', `a patch state nobody read: ${unjudged}`);

  // The same three forks on an advisory in triage, which is owed no patch.
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

  // A row carries no labels, so the chip names the embargo and says where it
  // stands. The date parts the overdue chip from the one in force, because a
  // tone never carries a fact the chip's words leave out.
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

// The fork holds four branches: one whose pull request has merged, two holding
// an open pull request, and one whose pull request was closed. Counting merged
// branches gives one and counting open branches gives two, so a fixture that
// answers 2 answers only under the open rule. REQUIREMENTS.md section 6 has the
// merged branch be unobservable in the first place, and the count measures how
// many backports have been prepared.
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
 * One page of the advisory list for a repository this file invents, in the
 * shape `parse-list` reads. The repository differs per test so that no two
 * tests share a refresh queue.
 *
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
 * The smallest document `parse-detail` reads as an advisory: the header meta
 * carrying the state, the severity, and the identifier. A row filled in from
 * one of these carries what a read supplies and nothing the fixtures add.
 *
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
 * A fetch that answers from a table of pages and records what was asked for.
 *
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
 * The wait a refresh here spends between requests: it moves the clock and
 * returns, so a pass costs no real time and the intervals are still exact.
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

  // The page being looked at is the draft tab, and GitHub rendered its row
  // now. The triage advisory below is on the table from the crawl alone: a
  // walk saw it two days ago, and every walk since has written the record
  // again without seeing it again.
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
  // Neither row has an advisory read behind it. The cell stands for when the
  // advisory was read, and when its list markup was seen is not that: one was
  // walked two days ago and the other was rendered by GitHub now.
  assert.ok(observed.get(ghsaId) === 'Not read', `the crawled row: ${observed.get(ghsaId)}`);
  assert.ok(observed.get(drawn) === 'Not read', `the row on the page: ${observed.get(drawn)}`);
});

test('a read supplies every value on the row it stamps', async () => {
  // GitHub rendered the list row now and it says one thing; the advisory read
  // the cache holds was taken two hours ago and says another. The row carries
  // one observation time, so it carries what that observation said.
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
  // The color travels with the level. The two pages paint the chip differently,
  // and the row takes the color off the page whose level it took.
  assert.ok(row.severityClass === 'Label--orange', `severity class: ${row.severityClass}`);
  // The read's page carries no title, so the list row is what fills that in:
  // the read supplies what it holds and nothing is invented for what it does
  // not.
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
  // `draft.html` is a real advisory with no severity set on it, so the read
  // holds neither a level nor a color and the list row supplies both.
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
  // The table around the row is untouched: a pass reads one advisory a second,
  // and a reader looking at the table keeps what they were looking at.
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
 * @returns {string | null} what the header says the refresh is doing, and null
 *   where it says nothing.
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

  // What the header said as each request went out. The sample is taken there
  // and not on the wait, because the wait between two requests carries a draw
  // that can round to nothing and then no wait is spent at all.
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

  // The first request is a list page, which is the walk. The three after it
  // are the advisories the walk named, counting down as each one lands.
  assert.deepStrictEqual(said, [
    table.WALKING_TEXT,
    'Loading (3 left)...',
    'Loading (2 left)...',
    'Loading (1 left)...',
  ]);
  assert.strictEqual(progressText(doc), null, 'the header still said a refresh was running');

  // The count the header carried all along is still beside it.
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
  // The second advisory's page is not in the table, so the fetch answers 404
  // for it. Nothing reports it, so the count the header carries never reaches
  // nothing on its own.
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

  assert.ok(summary !== null && summary.read.failed === 1, 'the missing page was read');
  assert.strictEqual(progressText(doc), null, 'the header still said a refresh was running');
});

test('the chip the header carries is dimmed and says nothing with nothing left', () => {
  const doc = pageOf('<div id="advisories"></div>');
  const walking = table.progressChip(doc, { phase: 'walking', left: 0 });
  assert.ok(walking !== null, 'the walk said nothing');
  // Color marks a condition to act on, and a refresh that is running is not one.
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

    // The page being looked at is the first page of triage, so the walk asks
    // for the other open state and for the two advisories, and for nothing it
    // already has.
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
    // A draft is a maintainer's own writing, so nobody is waiting on a review
    // of it and it is the maintainers who are holding it.
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
 * Waits for the surface's own machinery to get somewhere. A test that drives the
 * page rather than calling into it waits the way the page does: the observer
 * delivers its records, the loop takes its delay, and the refresh runs on its
 * own.
 *
 * @param {string} what What the surface was waited on to do, for the failure.
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

/**
 * @returns {Promise<void>} long enough for a request the surface should not
 *   send to have gone out if it were going to.
 */
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
  // The advisory read on the repository the page opened on does not answer
  // until this test lets it, so the navigation happens with a pass in flight.
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
    // The page as the content script finds it: one render loop, and an observer
    // watching for GitHub replacing the frame.
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

    // GitHub replaces the frame and keeps the document, and what is in it is
    // another repository's advisory list. The pass on the repository the page
    // left is still in flight.
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
  // Page two answers nothing, so the triage walk never reaches its last page
  // and every crawl that runs asks for it again. That is what makes a second
  // refresh visible: with every walk done and every advisory read, one would
  // spend nothing and there would be nothing to count.
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

    // The maintainer opens an advisory and comes back, twice. Neither is a
    // document load: the frame is replaced, and the table goes and comes back
    // with it.
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

    // Six minutes on, the walks and the read are due again, and coming back to
    // the list is what starts them.
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
  // The first advisory read on the repository the page opened on does not
  // answer until this test lets it, so the navigation happens with a request in
  // flight and a second advisory still queued behind it.
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

    // GitHub replaces the frame and keeps the document, and what is in it is
    // another repository's advisory list.
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
    // The advisory the stopped pass had left is waiting where the next page
    // load reads it, and the one it read is not.
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
  // Page two answers nothing, so the triage walk never reaches its last page and
  // the walk that comes back to this repository asks for that page again. What
  // the pass left behind is a walk part way through as well as an advisory
  // unread.
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

    // The maintainer opens something that is not an advisory list. The frame is
    // replaced and the table goes with it, and the pass is reading for a page
    // nobody is on.
    const frame = one(doc, '#repo-content-turbo-frame');
    frame.innerHTML = '<div id="show_dialog"></div>';
    assert.ok(doc.getElementById(table.ROOT_ID) === null, 'the table went with the frame');
    // Long enough for the surface to take the page in: the observer delivers
    // its records and the loop takes its delay, and the stop lands on a pass
    // whose request is still in flight.
    await quiet();
    release();
    await quiet();
    assert.deepStrictEqual(
      urls,
      [...walked, `${base}/${first}`],
      'the pass went on reading a repository the page had left'
    );

    // Straight back to the list. The pass is taken back where it stopped: the
    // walk carries on from the page it was holding, the advisory already read
    // is in the cache and costs nothing, and the one never reached is read.
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
   * @returns {import('../src/common/crawl.js').StateWalk} a walk that reached
   *   its last page a moment ago, so nothing about it is due.
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

  // `start` reads the document off the global and the queue it makes reads the
  // global fetch, because nothing on a page injects either. Everything here is
  // fresh, so a surface that behaves sends nothing at all.
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
  // GitHub treats an owner and a repository name case-insensitively, and two
  // queues would each hold the rate limit privately.
  const spelled = table.queueFor({ owner: 'Crawl-One', repo: 'Repo' });
  assert.ok(spelled === first, 'another spelling of one repository made a second queue');
  const other = table.queueFor({ owner: 'crawl-two', repo: 'repo' });
  assert.ok(other !== first, 'two repositories shared one queue');
});

/**
 * @param {string} ghsaId
 * @param {Partial<import('../src/list/table.js').TableRow>} [changes]
 * @returns {import('../src/list/table.js').TableRow} a row carrying the list
 *   markup's defaults, with the values one case turns on.
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
 * One sort key, and three rows it ranks C first, A second, B third.
 *
 * Every case is handed to the sort as A, B, C, and every case wants C, A, B. So
 * neither the order the rows arrive in nor the order of their identifiers can
 * stand in for the key under test: a comparator that ignored the key would
 * answer A B C through the identifier tie-break and fail.
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

  // The facet a cut filter read is gone, so nothing offers its values and
  // nothing can be held to one of them.
  assert.strictEqual(table.facetFor('cve'), null, 'the CVE facet is still here');
  const row = sortRow('A', { read: true, cve: 'CVE-2026-0001' });
  assert.strictEqual(
    table.applyView([row], { sort: table.DEFAULT_SORT, filters: { cve: 'Assigned' } }).length,
    1,
    'a filter over the cut CVE facet still holds the table'
  );

  // The comparator a cut sort ran is gone, so the key falls back to the
  // default order in place of ordering by title.
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
  // Alphabetically these read Critical, High, Low, Moderate, so an option list
  // in rank order is one the alphabet cannot produce.
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

  // A row nobody has read holds nothing, and that is not a value to offer.
  const unread = table.filterOptions([...rows, sortRow('E')], facet('severity'), '');
  assert.ok(unread.join(' ') === 'Critical High Moderate Low', `an unread row: ${unread.join(' ')}`);

  // A login this reader has no rank for falls back to the alphabet.
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
 * Rows covering every branch of every comparator the sort control offers: the
 * severity and the waiting time the two facet sorts read, and the state, group
 * and tie-break keys the default order reads on top of them. The identifier
 * descends as the grid is built, so the order the rows arrive in and the order
 * of their identifiers contradict each other.
 *
 * The lists have lengths 3, 4, 3 and 4, so the values repeat every twelve rows
 * and a grid of twenty-four holds each combination the walk reaches twice under
 * two identifiers. That is what makes a tie the identifier has to settle part
 * of the grid.
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
  // The identifier is the last tie-break on both paths: the default order runs
  // `order.compare`, and every other sort ends in this file's own tie-break.
  // The two read a null identifier the same way, so the row nobody can open is
  // at the bottom either way.
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
 * @returns {string} what each facet reads for one row, as one line.
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

  // The same advisory before anything has been read holds what GitHub's row
  // said and nothing a read supplies, so a filter over those facets keeps it.
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
 * @returns {string} what the Patch filter reads off that row.
 */
function patchValueOf(changes) {
  const facet = table.FACETS.find((each) => each.key === 'patch');
  if (facet === undefined) throw new Error('the table offers no patch facet');
  return facet.valuesOf(rowWith(changes)).join('+');
}

// The Patch filter and the patch chip describe the same rows. The chip stands
// on a draft and on no other, so a triage advisory holding an open pull request
// must not filter under a value its row never shows.
test('the patch filter reads a draft row and no other', () => {
  assert.strictEqual(patchValueOf({ read: true, state: 'Draft', patch: 'Patch in review' }), 'In review');
  assert.strictEqual(patchValueOf({ read: true, state: 'Draft', patch: 'No patch yet' }), 'No patch');

  // A draft whose pull request named a state this reader does not know shows
  // `Unknown`, which is the absence of an answer and not one of the two values.
  assert.strictEqual(patchValueOf({ read: true, state: 'Draft', patch: 'Unknown' }), '');

  for (const state of ['Triage', 'Published', 'Closed', null]) {
    assert.strictEqual(
      patchValueOf({ read: true, state, patch: 'Patch in review' }),
      '',
      `a ${state} advisory with an open pull request filters under a chip it does not show`
    );
    assert.strictEqual(patchValueOf({ read: true, state, patch: 'No patch yet' }), '');
  }

  // A row nothing has been read on holds no patch state at all.
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
 * Presses an item the way a maintainer does.
 *
 * @param {Element} control
 * @param {string} value What the item holds the control to.
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
 * @returns {string} what its menu offers, as one line.
 */
function itemsOf(control) {
  return itemNodes(control)
    .map((item) => item.textContent ?? '')
    .join(' | ');
}

/**
 * @param {Element} control
 * @returns {string} the value of the one item its menu marks checked. Where it
 *   marks none or marks several, that is what comes back, because a menu
 *   carrying two checks is as wrong as one carrying none.
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
 * A table drawn over rows a test made up, placed on a real list page so it has
 * the anchor the page offers.
 *
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

  // Every filter comes up holding the table to nothing, reading the facet it
  // acts on, and offering what the rows of the table hold.
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
 * A table over two advisories one owner apiece, which is what the filter menus
 * below offer the values of.
 *
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
 * @returns {string} what the summary of one filter reads.
 */
function summaryOf(doc, facet) {
  return (
    one(doc, `#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}="${facet}"] > summary`).textContent ?? ''
  );
}

test('a filter menu says to a screen reader what it is and whether it is open', () => {
  const { doc } = ownedTable();
  const control = filterIn(doc, 'owner');

  // The open state is the native details element's, which a screen reader
  // reads off the element itself. Nothing declares it a second time, because a
  // declared state is one that can go stale while the menu is open.
  assert.ok(control.tagName.toLowerCase() === 'details', `the control is a ${control.tagName}`);
  const box = one(doc, `#${table.ROOT_ID} .bghsa-list-controls`);
  assert.ok(box.querySelector('[aria-expanded]') === null, 'a control carries aria-expanded');

  // The face of the menu, which is what a reader lands on before it is open.
  const summary = one(doc, `#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}="owner"] > summary`);
  assert.ok(summary.getAttribute('role') === 'button', 'the summary does not say it is a button');
  assert.ok(
    summary.getAttribute('aria-haspopup') === 'menu',
    'the summary does not say it opens a menu'
  );

  // What opens, named so that a reader arriving in it knows which filter it
  // belongs to, since the summary is no longer what is being read.
  const body = one(doc, `#${table.ROOT_ID} [${table.FACET_ATTRIBUTE}="owner"] details-menu`);
  assert.ok(body.getAttribute('role') === 'menu', 'the menu does not say it is one');
  assert.ok(
    body.getAttribute('aria-label') === 'Owner',
    `the menu is labeled: ${body.getAttribute('aria-label')}`
  );

  // One of these is held at a time, which is what parts a radio item from a
  // checkbox item to a reader moving through the menu.
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
  // The summary says what the filter is holding to without the menu being
  // opened, which is what the face of a select used to carry.
  assert.ok(summaryOf(doc, 'owner') === 'Owner: ada', `the summary reads: ${summaryOf(doc, 'owner')}`);
  // The sort is a menu of its own, and pressing an owner leaves it alone.
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
  // The controls read the view that is showing, so the way back is not hidden
  // behind controls still naming the view that was.
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
  // The default order leads with the advisory blocked on us; the waiting sort
  // leads with the one that has waited longest, so the two disagree.
  assert.ok(shownIds(doc) === `GHSA-aaaa-aaaa-aaaa ${ghsaId}`, `the default order: ${shownIds(doc)}`);
  press(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'waiting');
  press(filterIn(doc, 'owner'), 'ada');
  // A row nobody has read is not hidden by a filter over a value a read
  // supplies, so both are showing.
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

  // The read turns the row into one the owner filter does not match and one the
  // default order would put in another group. It keeps its place and it keeps
  // showing: the view a maintainer is reading is not rearranged under them.
  assert.ok(shownIds(doc) === `${ghsaId} GHSA-aaaa-aaaa-aaaa`, `after the read: ${shownIds(doc)}`);
  const row = /** @type {Element} */ (tableRows(doc)[0]);
  assert.ok(
    chipLine(row) === 'Never reviewed[Label--secondary bghsa-tone-danger] |' +
      ' High, unconfirmed[Label--secondary bghsa-dim]',
    `the row took the read in: ${chipLine(row)}`
  );
  // The read turned up a severity no row carried, and the control offers it.
  assert.ok(
    itemsOf(filterIn(doc, 'severity')) === 'Any | High | None',
    `the severity filter after the read: ${itemsOf(filterIn(doc, 'severity'))}`
  );

  // The render that follows the pass is what settles it, under the same view.
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
  // The table took the read in even so, which the filter shows once it is
  // holding to what the read turned up.
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
  // The default order leads with the draft, and the severity sort leads with
  // the high, so the two disagree and a picked sort is visible.
  assert.ok(shownIds(doc) === `${low} ${high}`, `the default order: ${shownIds(doc)}`);

  press(one(doc, `#${table.ROOT_ID} .bghsa-list-sort`), 'severity');
  assert.ok(shownIds(doc) === `${high} ${low}`, `the highest severity first: ${shownIds(doc)}`);
  press(filterIn(doc, 'severity'), 'Low');
  assert.ok(shownIds(doc) === low, `held to the low severity: ${shownIds(doc)}`);

  // GitHub replacing the subtree, and the pass that follows a read, both draw
  // the table again. The view a maintainer picked survives that.
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
