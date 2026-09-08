'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML, DOMParser } = require('linkedom');

const cache = require('../src/common/cache.js');
const parseList = require('../src/common/parse-list.js');
const parseDetail = require('../src/common/parse-detail.js');
const schema = require('../src/common/schema.js');
const write = require('../src/common/write.js');
const members = require('../src/common/members.js');
const branches = require('../src/common/branches.js');
const edit = require('../src/detail/edit.js');
const table = require('../src/list/table.js');
const corpus = require('../src/done/corpus.js');
const view = require('../src/done/view.js');
const statistics = require('../src/stats/statistics.js');

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

// The queue and the crawl turn a fetched page into a document the way a content
// script does. Nothing in this file reaches the network: every response is a
// string a test wrote.
globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

/** The repository the list fixture belongs to, and the one on the allowlist. */
const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

/** The advisory the triage fixture holds. */
const TRIAGE_ID = 'GHSA-jmvx-2wfw-xfgj';

test('the storage stand-in holds a copy of what it was seeded with', async () => {
  // `browser.storage.local` stores a structured clone. A fake holding the
  // caller's own object would let the code under test read back a change it
  // never wrote, and would carry a write out of the test that made it.
  const held = { advisory: { read: 1 } };
  const store = fakeStorage(held);
  await store.set({ advisory: { read: 2 } });
  assert.deepStrictEqual(held, { advisory: { read: 1 } }, 'a write reached the seed');
  assert.deepStrictEqual((await store.get('advisory'))['advisory'], { read: 2 });
});

const MINUTE = 60 * 1000;

/** A clock the queue moves rather than waiting on, so a crawl costs no time. */
let clockAt = Date.parse('2026-08-27T12:00:00Z');
cache.setClock(() => clockAt);
cache.setStorage(fakeStorage());

/** What the queue answers with, by path. A test fills this in before it runs. */
/** @type {Record<string, string>} */
const pages = {};

/** Every path the queue asked for, in order. @type {string[]} */
const asked = [];

/**
 * What to run while a path is being answered, by path. A test that has to act
 * while a collection is in flight puts the act here, and it runs once: the
 * entry is taken out before it is called, so a retry of the same path does not
 * run it again.
 *
 * @type {Record<string, () => Promise<void>>}
 */
const during = {};

/**
 * What a queue this file makes reads and waits with. Every answer is a string a
 * test wrote, so no queue made with these reaches the network, whichever
 * repository it is for.
 *
 * @type {import('../src/list/table.js').RefreshOptions}
 */
const QUEUE_OPTIONS = {
  storage: cache.storageOf(),
  now: () => clockAt,
  wait: async (ms) => {
    clockAt += ms;
  },
  fetch: async (url) => {
    asked.push(url);
    const act = during[url];
    if (act !== undefined) {
      delete during[url];
      await act();
    }
    const body = pages[url];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  },
};

/**
 * The one queue this repository's requests go through, made here so the view's
 * own collection finds it rather than making one that would reach the network.
 */
table.queueFor(REF, QUEUE_OPTIONS);

/**
 * @param {string} name
 * @returns {string} one fixture's markup.
 */
function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'testdata', name), 'utf8');
}

/**
 * @param {string} html
 * @returns {Document}
 */
function document(html) {
  return /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
}

/**
 * The list fixture inside the frame GitHub replaces on a soft navigation.
 *
 * @param {string} name
 * @returns {Document}
 */
function listPage(name) {
  return document(
    '<!doctype html><html><head></head><body><div id="repo-content-turbo-frame">' +
      fixture(name) +
      '</div></body></html>'
  );
}

/**
 * Lets the work a control started off a change event finish. Staging a reason
 * reads the advisory's stored state, and reading it hashes the values the
 * confirmations bind to, so the store catches up some turns after the pick.
 *
 * @returns {Promise<void>}
 */
async function settled() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
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
 * @returns {string}
 */
function textOf(scope, selector) {
  return (one(scope, selector).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {ParentNode} scope
 * @param {string} selector
 * @returns {string[]} what every match reads, whitespace collapsed.
 */
function textsOf(scope, selector) {
  return Array.from(scope.querySelectorAll(selector)).map((node) =>
    (node.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

/**
 * Picks an option the way a maintainer does. The selection is the `selected`
 * attribute here, which is what this document model reads a select's value
 * from.
 *
 * @param {Element} select
 * @param {string} value
 * @returns {void}
 */
function choose(select, value) {
  for (const option of select.querySelectorAll('option')) {
    if ((option.getAttribute('value') ?? '') === value) option.setAttribute('selected', '');
    else option.removeAttribute('selected');
  }
  const view = select.ownerDocument?.defaultView;
  if (view === null || view === undefined) throw new Error('the document has no view');
  select.dispatchEvent(new view.Event('change', { bubbles: true }));
}

/**
 * @param {Element} row
 * @returns {string} every chip under one row's title, as one line. The chips
 *   sit against each other, so the text alone runs them together.
 */
function chipLine(row) {
  return textsOf(row, '.bghsa-done-chips span.Label').join(' ');
}

/**
 * @param {Element} row
 * @returns {string} the state chip, which stands in a cell of its own beside
 *   the title, and an empty string on a row carrying none.
 */
function stateLine(row) {
  return textsOf(row, '.bghsa-done-state span.Label').join(' ');
}

/**
 * @param {Element} node
 * @param {string} selector
 * @returns {string[]} how each chip that selector finds is colored: every class
 *   on it other than `Label`, in the order it carries them.
 */
function colorsOf(node, selector) {
  return Array.from(node.querySelectorAll(selector)).map((label) =>
    (label.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name !== '' && name !== 'Label')
      .join(' ')
  );
}

/**
 * @param {Element} row
 * @returns {string[]} how each chip under one row's title is colored.
 */
function chipColors(row) {
  return colorsOf(row, '.bghsa-done-chips span.Label');
}

/**
 * @param {Element} row
 * @returns {string[]} how the state chip in its own cell is colored.
 */
function stateColors(row) {
  return colorsOf(row, '.bghsa-done-state span.Label');
}

/**
 * @param {Element} row
 * @param {string} prefix What the surface drawing the row names its own parts.
 * @returns {string[]} what each cell beside the main column holds, in the order
 *   the row draws them. The main column is the first child, so the cells are
 *   what follows it.
 */
function cellsOf(row, prefix) {
  return Array.from(row.children)
    .slice(1)
    .map((cell) => {
      if (cell.querySelector(`.bghsa-${prefix}-closure`) !== null) return 'reason';
      if (cell.querySelector(`.bghsa-${prefix}-owners`) !== null) return 'owners';
      if (cell.classList.contains(`bghsa-${prefix}-state`)) return 'state';
      if (cell.classList.contains(`bghsa-${prefix}-observed`)) return 'observed';
      return cell.getAttribute('class') ?? '';
    });
}

/**
 * @param {Document} doc
 * @param {string} ghsaId
 * @returns {Element} that advisory's row on the done view. The table carries a
 *   row under the same attribute, so the view is named in the query.
 */
function doneRow(doc, ghsaId) {
  return one(doc, `#${view.ROOT_ID} [data-bghsa-ghsa="${ghsaId}"]`);
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle this view puts on the bar.
 */
function doneToggle(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-done-toggle`))
  );
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle that opens the statistics.
 */
function statsToggle(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-stats-toggle`))
  );
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle that restores GitHub's view.
 */
function githubToggle(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-list-toggle`))
  );
}

/**
 * @param {string} suffix
 * @returns {string}
 */
function ghsa(suffix) {
  return `GHSA-${suffix}-${suffix}-${suffix}`;
}

/**
 * One page of the advisory list, in the shape `parse-list` reads.
 *
 * @param {{ state: string, ids: readonly string[], counts?: Record<string, number> }} page
 * @returns {string}
 */
function listHtml(page) {
  const label = /** @type {string} */ (parseList.STATES[page.state]);
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  const counts = page.counts ?? {};
  const tabs = Object.entries(parseList.STATES)
    .map(
      ([state, name]) =>
        `<li class="SegmentedControl-item"><a href="${base}?state=${state}"${
          state === page.state ? ' aria-current="true"' : ''
        }>${counts[state] ?? 0} ${name}</a></li>`
    )
    .join('');
  const rows = page.ids
    .map(
      (id) =>
        '<div class="Box-row Box-row--drag-hide">' +
        `<a class="Link--primary" href="${base}/${id}">Title ${id}</a>` +
        `<span class="tooltipped" aria-label="${label} advisory"></span>` +
        '<span class="Label" title="Severity: High">High</span>' +
        '<span class="opened-by">opened <relative-time datetime="2026-03-02T00:00:00Z">' +
        '</relative-time> by <a class="author" href="/prakleumas">prakleumas</a></span>' +
        '</div>'
    )
    .join('');
  // GitHub's pagination is a sibling of the Box, which is where the real page
  // puts it.
  return (
    `<div id="advisories"><segmented-control><ul>${tabs}</ul></segmented-control>` +
    `<div class="Box">${rows}</div>` +
    '<div class="paginate-container"><div class="pagination">' +
    '<span class="previous_page disabled">Previous</span>' +
    '<span class="next_page disabled">Next</span>' +
    '</div></div></div>'
  );
}

/**
 * One advisory detail page, in the shape `parse-detail` reads.
 *
 * @param {{ ghsaId: string, state: string, reportedAt: string }} advisory
 * @returns {string}
 */
function detailHtml(advisory) {
  return (
    `<div class="gh-header-meta"><span class="State">${advisory.state}</span>` +
    '<span class="Label--large" title="Severity: High">High</span>' +
    `<span class="user-select-contain">${advisory.ghsaId}</span></div>` +
    '<div class="js-repository-advisory-details"><div class="Box-header timeline-comment-header">' +
    '<a class="author" href="/prakleumas">prakleumas</a> opened ' +
    `<relative-time datetime="${advisory.reportedAt}"></relative-time></div></div>`
  );
}

/**
 * @param {string} ghsaId
 * @returns {string}
 */
function detailUrl(ghsaId) {
  return `/${REF.owner}/${REF.repo}/security/advisories/${ghsaId}`;
}

/** An advisory in the shape the parser produces, carrying only what is read. */
/**
 * @param {Partial<import('../src/common/parse-detail.js').ParsedDetail>} fields
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function advisory(fields) {
  return {
    ref: null,
    viewer: null,
    ghsaId: null,
    state: null,
    severity: null,
    severityLabel: null,
    severityClass: null,
    reportedAt: null,
    reporter: null,
    title: null,
    description: null,
    severityField: null,
    severityFieldPresent: false,
    cvssV3: null,
    cvssV3Present: false,
    cveId: null,
    cveSelection: null,
    descriptionOriginal: null,
    descriptionRevision: null,
    comments: [],
    timeline: [],
    fork: null,
    collaborators: [],
    ...fields,
  };
}

/**
 * @param {{
 *   ghsaId: string,
 *   state: string,
 *   title?: string | null,
 *   severity?: string | null,
 *   severityClass?: string | null,
 *   openedAt?: string | null,
 *   advisory?: import('../src/common/parse-detail.js').ParsedDetail | null,
 * }} fields
 * @returns {import('../src/done/corpus.js').CorpusMember}
 */
function member(fields) {
  const read = fields.advisory ?? null;
  return {
    ghsaId: fields.ghsaId,
    state: fields.state,
    seenAt: 0,
    advisory: read,
    observedAt: read === null ? null : Date.parse('2026-08-27T09:00:00Z'),
    row: {
      ghsaId: fields.ghsaId,
      owner: REF.owner,
      repo: REF.repo,
      href: `/${REF.owner}/${REF.repo}/security/advisories/${fields.ghsaId}`,
      title: fields.title ?? null,
      state: fields.state,
      severity: fields.severity ?? null,
      severityLabel: null,
      severityClass: fields.severityClass ?? null,
      openedAt: fields.openedAt ?? null,
      reporter: 'prakleumas',
    },
  };
}

/**
 * @param {readonly import('../src/done/corpus.js').CorpusMember[]} members
 * @param {{ complete?: boolean, running?: boolean, expected?: Record<string, number | null> }} [over]
 * @returns {import('../src/done/corpus.js').Corpus}
 */
function corpusOf(members, over = {}) {
  return {
    members: [...members],
    unread: members.filter((each) => each.advisory === null).map((each) => each.ghsaId),
    complete: over.complete ?? true,
    running: over.running ?? false,
    expected: over.expected ?? { published: null, closed: null },
  };
}

/**
 * The corpus as production builds it: `membersOf` over the crawl's rows and
 * the cache's entries. Nothing here hands a member an advisory object. A
 * member's advisory is what `record.advisoryFrom` reads back out of storage,
 * which is the only advisory the done view ever holds, so a control this
 * exercises is the control a maintainer gets.
 *
 * @param {readonly { ghsaId: string, state: string, record?: unknown }[]} entries
 * @returns {Promise<import('../src/done/corpus.js').Corpus>}
 */
async function cachedCorpus(entries) {
  /** @type {Record<string, unknown>} */
  const stored = {};
  /** @type {import('../src/common/crawl.js').CrawledList} */
  const list = { walks: {}, rows: {} };
  for (const entry of entries) {
    list.rows[entry.ghsaId] = {
      row: member({ ghsaId: entry.ghsaId, state: entry.state }).row,
      state: entry.state,
      seenAt: clockAt,
    };
    if (entry.record === undefined) continue;
    const key = /** @type {string} */ (cache.advisoryKey({ ...REF, ghsaId: entry.ghsaId }));
    stored[key] = { record: entry.record, observedAt: clockAt, state: entry.state };
  }
  return corpus.membersOf(REF, list, {
    storage: fakeStorage(stored),
    at: clockAt,
    complete: true,
    expected: { published: null, closed: null },
  });
}

/**
 * A rendered list page carrying the extension's table and this view.
 *
 * @param {import('../src/done/corpus.js').Corpus | null} [corpus]
 * @returns {Promise<Document>}
 */
async function page(corpus = null) {
  const doc = listPage('list-page-triage.html');
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');
  if (corpus !== null) {
    view.setState(doc, { corpus, ref: REF });
    view.draw(doc);
  }
  return doc;
}

test('the done view is reached from a toggle beside the one for GitHub', async () => {
  const published = [ghsa('aaaa'), ghsa('bbbb')];
  const closed = [ghsa('cccc')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: published,
    counts: { published: 2, closed: 1 },
  });
  pages[`${base}?state=closed`] = listHtml({
    state: 'closed',
    ids: closed,
    counts: { published: 2, closed: 1 },
  });
  for (const id of published) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  for (const id of closed) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Closed',
      reportedAt: '2026-04-05T00:00:00Z',
    });
  }

  const doc = await page();
  const toggle = doneToggle(doc);
  assert.strictEqual(
    (toggle.textContent ?? '').trim(),
    'Show completed',
    'the toggle offers the view'
  );
  assert.ok(
    toggle.previousElementSibling === githubToggle(doc),
    "the toggle sits beside the one that restores GitHub's view"
  );

  const before = asked.length;
  toggle.click();
  await view.collect(doc);

  assert.strictEqual(table.viewMode(doc), view.MODE, 'the page is on the done view');
  assert.strictEqual(
    (doneToggle(doc).textContent ?? '').trim(),
    'Show open',
    'and the toggle offers the way back'
  );

  // The list pages and every advisory they name, all through the one queue the
  // list surface holds for this repository.
  assert.deepStrictEqual(asked.slice(before), [
    `${base}?state=published`,
    `${base}?state=closed`,
    detailUrl(published[0] ?? ''),
    detailUrl(published[1] ?? ''),
    detailUrl(closed[0] ?? ''),
  ]);

  const rows = doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`);
  assert.strictEqual(rows.length, 3, `rows on the done view: ${rows.length}`);
  assert.deepStrictEqual(
    Array.from(rows).map((row) => row.getAttribute('data-bghsa-ghsa')),
    [...published, ...closed].sort()
  );
  assert.deepStrictEqual(
    Array.from(rows).map(stateLine),
    ['Published', 'Published', 'Closed'],
    'each row says which done state it is in'
  );
  assert.deepStrictEqual(
    Array.from(rows).map(chipLine),
    ['High', 'High', ''],
    'and carries its severity under the title'
  );
  assert.strictEqual(
    textOf(doc, `#${view.ROOT_ID} .bghsa-done-count`),
    '3 advisories',
    'the header counts what the view holds'
  );

  // Nothing the view inserts reads back as one of GitHub's own rows.
  const inserted = one(doc, `#${view.ROOT_ID}`).querySelectorAll(
    table.PARSED_SELECTORS.join(', ')
  ).length;
  assert.strictEqual(inserted, 0, `nodes parse-list would key on: ${inserted}`);
  const reread = parseList.parseList(doc);
  assert.strictEqual(reread?.rows.length, 1, "a re-read still finds GitHub's one row");
});

test("the four views converge, and GitHub's own view comes back whole", async () => {
  const doc = await page(
    corpusOf([member({ ghsaId: ghsa('dddd'), state: 'published', title: 'A published advisory' })])
  );
  const container = one(doc, '#advisories');
  const native = table.nativeControls(container);
  const listBox = one(doc, `#${table.ROOT_ID} .bghsa-list-box`);

  /**
   * @returns {string} which of the four is in view, named once. Two of them
   *   showing at once, or none, is what this catches.
   */
  const showing = () => {
    const shown = [];
    if (native.some((node) => !node.classList.contains(table.HIDDEN_CLASS))) shown.push('native');
    if (!listBox.classList.contains(table.HIDDEN_CLASS)) shown.push('table');
    if (!one(doc, `#${view.ROOT_ID}`).classList.contains(table.HIDDEN_CLASS)) shown.push('done');
    if (!one(doc, `#${statistics.ROOT_ID}`).classList.contains(table.HIDDEN_CLASS)) {
      shown.push('statistics');
    }
    return shown.join('+');
  };

  /**
   * @param {HTMLElement} node
   * @returns {void} presses a control the way a maintainer reaches it. A
   *   control held out of view accepts a synthetic click, so a press of one is
   *   this test's own defect and is reported as one.
   */
  const press = (node) => {
    assert.ok(
      !node.classList.contains(table.HIDDEN_CLASS),
      `pressed a control held out of view: ${node.className}`
    );
    node.click();
  };

  assert.strictEqual(showing(), 'table', 'a fresh page comes up on the table');

  press(doneToggle(doc));
  assert.strictEqual(showing(), 'done');
  press(statsToggle(doc));
  assert.strictEqual(showing(), 'statistics', 'the statistics open from the done view');
  press(doneToggle(doc));
  assert.strictEqual(showing(), 'done', 'and the done view from the statistics');
  press(githubToggle(doc));
  assert.strictEqual(showing(), 'native', "the done view gives way to GitHub's");

  // GitHub's own view carries one control of the extension's, the way back, so
  // neither of the other two views can be opened from here.
  assert.ok(
    doneToggle(doc).classList.contains(table.HIDDEN_CLASS),
    "the done toggle is out of reach while GitHub's view is showing"
  );
  assert.ok(
    statsToggle(doc).classList.contains(table.HIDDEN_CLASS),
    "the statistics toggle is out of reach while GitHub's view is showing"
  );

  press(githubToggle(doc));
  assert.strictEqual(showing(), 'table', 'the way back lands on the table');
  press(statsToggle(doc));
  assert.strictEqual(showing(), 'statistics', 'the statistics open from the table');
  press(githubToggle(doc));
  assert.strictEqual(showing(), 'native', "the statistics give way to GitHub's");
  press(githubToggle(doc));
  assert.strictEqual(showing(), 'table', 'and the way back lands on the table again');
  press(statsToggle(doc));
  assert.strictEqual(showing(), 'statistics');
  press(statsToggle(doc));
  assert.strictEqual(showing(), 'table', 'pressing it again gives the table back');
  press(doneToggle(doc));
  assert.strictEqual(showing(), 'done');
  press(doneToggle(doc));
  assert.strictEqual(showing(), 'table', 'and so does pressing the done toggle again');

  // Hiding is not destroying: what came back is GitHub's own view, whole. It is
  // reached from each of the extension's three views in turn.
  for (const open of [() => {}, () => press(doneToggle(doc)), () => press(statsToggle(doc))]) {
    open();
    press(githubToggle(doc));
    assert.strictEqual(showing(), 'native');
    assert.strictEqual(
      doc.querySelectorAll('#advisories div.Box-row--drag-hide').length,
      1,
      "GitHub's own rows"
    );
    assert.strictEqual(
      doc.querySelectorAll('#advisories segmented-control a[href]').length,
      4,
      'the state tabs'
    );
    assert.strictEqual(
      doc.querySelectorAll('#advisories repository-advisories-filter form').length,
      1,
      'the query form'
    );
    press(githubToggle(doc));
    assert.strictEqual(showing(), 'table');
  }

  assert.ok(
    doc.getElementById(view.ROOT_ID) !== null,
    'the done view is held out of view, not taken away'
  );
  assert.ok(
    doc.getElementById(statistics.ROOT_ID) !== null,
    'and so are the statistics'
  );
});

test('the state chip is colored by the ending and the severity by GitHub', async () => {
  const painted = ghsa('aaaa');
  const read = ghsa('bbbb');
  const bare = ghsa('cccc');
  const neither = ghsa('cccd');
  const doc = await page(
    await corpusOf([
      // The class GitHub painted this advisory's own severity chip with. It is
      // not the class for `low`, so what comes out can only be what was carried.
      member({
        ghsaId: painted,
        state: 'published',
        severity: 'low',
        severityClass: 'Label--orange',
      }),
      // A read supplies the level, so it supplies the color with it.
      member({
        ghsaId: read,
        state: 'published',
        severity: 'low',
        severityClass: 'Label--orange',
        advisory: advisory({
          ref: { ...REF, ghsaId: read },
          ghsaId: read,
          state: 'Published',
          severity: 'moderate',
          severityLabel: 'Moderate',
          severityClass: 'Label--warning',
        }),
      }),
      // Nothing to reuse, so GitHub's neutral modifier stands in.
      member({ ghsaId: bare, state: 'published', severity: 'low' }),
      // The crawl found this one under `?state=closed` and its own page says
      // Triage. The page is what the row reads, and the two endings are the
      // only states a color is named for.
      member({
        ghsaId: neither,
        state: 'closed',
        severity: 'low',
        advisory: advisory({
          ref: { ...REF, ghsaId: neither },
          ghsaId: neither,
          state: 'Triage',
          severity: 'low',
          severityLabel: 'Low',
        }),
      }),
    ])
  );

  assert.deepStrictEqual(stateLine(doneRow(doc, painted)), 'Published');
  assert.deepStrictEqual(chipLine(doneRow(doc, painted)), 'Low');
  assert.deepStrictEqual(
    stateColors(doneRow(doc, painted)),
    ['Label--secondary bghsa-tone-success'],
    'a published advisory reads green'
  );
  assert.deepStrictEqual(
    chipColors(doneRow(doc, painted)),
    ['Label--orange bghsa-fill'],
    'beside a severity filled in its own color'
  );

  assert.deepStrictEqual(stateLine(doneRow(doc, read)), 'Published');
  assert.deepStrictEqual(chipLine(doneRow(doc, read)), 'Moderate');
  assert.deepStrictEqual(
    chipColors(doneRow(doc, read)),
    ['Label--warning bghsa-fill'],
    'the severity color comes from whichever read supplied the level'
  );

  assert.deepStrictEqual(
    chipColors(doneRow(doc, bare)),
    ['Label--secondary bghsa-fill'],
    'a severity GitHub carried no modifier on'
  );

  assert.deepStrictEqual(stateLine(doneRow(doc, neither)), 'Triage');
  assert.deepStrictEqual(chipLine(doneRow(doc, neither)), 'Low');
  assert.deepStrictEqual(
    stateColors(doneRow(doc, neither)),
    ['Label--secondary'],
    'a state that is neither ending takes no color'
  );
  assert.deepStrictEqual(
    chipColors(doneRow(doc, neither)),
    ['Label--secondary'],
    'and its severity takes no fill'
  );

  // A chip carrying a color no rule defines draws as though it carried none.
  for (const name of ['bghsa-tone-done', 'bghsa-tone-success', 'bghsa-fill']) {
    assert.ok(view.STYLE_TEXT.includes(`.${name} {`), `no rule defines .${name}`);
  }
});

test("a completed row carries the line GitHub's own row carried", async () => {
  // The open list draws this line from the same builder, so the two lists
  // cannot come to say a report was opened on different days.
  const closed = ghsa('ceec');
  const doc = await page(
    await corpusOf([member({ ghsaId: closed, state: 'closed', openedAt: '2026-03-14T00:00:00Z' })])
  );

  assert.strictEqual(
    textOf(doneRow(doc, closed), '.bghsa-done-meta'),
    `${closed} opened 2026-03-14 by prakleumas`
  );
});

test('both lists put the state and the observation in their last two cells', async () => {
  // The two rows are drawn by one builder: a maintainer moving between the
  // open list and the completed one finds the state and the observation in the
  // same place on both.
  const closed = ghsa('cbcb');
  const doc = await page(await corpusOf([member({ ghsaId: closed, state: 'closed' })]));

  assert.deepStrictEqual(
    cellsOf(doneRow(doc, closed), 'done'),
    ['reason', 'state', 'observed'],
    'the completed row'
  );
  assert.deepStrictEqual(
    cellsOf(one(doc, `#${table.ROOT_ID} li.bghsa-list-row`), 'list'),
    ['state', 'observed'],
    'and the open row behind it'
  );
});

test('the severity chip stands on a published row and not on a closed one', async () => {
  // One severity, one color, and two states over it, so a row that drew the
  // chip from the level alone would draw both.
  const published = ghsa('ccce');
  const closed = ghsa('cccf');
  const doc = await page(
    await corpusOf([
      member({ ghsaId: published, state: 'published', severity: 'high', severityClass: 'Label--orange' }),
      member({ ghsaId: closed, state: 'closed', severity: 'high', severityClass: 'Label--orange' }),
    ])
  );

  assert.strictEqual(stateLine(doneRow(doc, published)), 'Published');
  assert.strictEqual(chipLine(doneRow(doc, published)), 'High');
  assert.deepStrictEqual(
    stateColors(doneRow(doc, closed)),
    ['Label--secondary bghsa-tone-done'],
    'a closed advisory reads purple'
  );
  assert.strictEqual(
    chipLine(doneRow(doc, closed)),
    '',
    'and carries no severity under its title'
  );
});

test('the reason control stands on a closed row and not on a published one', async () => {
  // Both rows are backed by a read, so the control's presence can only follow
  // from the state the row is in.
  const closed = ghsa('cdcd');
  const published = ghsa('dcdc');
  const doc = await page(
    await corpusOf([
      member({
        ghsaId: closed,
        state: 'closed',
        advisory: advisory({ ref: { ...REF, ghsaId: closed }, ghsaId: closed, state: 'Closed' }),
      }),
      member({
        ghsaId: published,
        state: 'published',
        advisory: advisory({
          ref: { ...REF, ghsaId: published },
          ghsaId: published,
          state: 'Published',
        }),
      }),
    ])
  );

  assert.ok(
    doneRow(doc, closed).querySelector('select.bghsa-done-reason') !== null,
    'a closed row offers no reason to set'
  );
  assert.strictEqual(
    doneRow(doc, published).querySelector('.bghsa-done-closure'),
    null,
    'a published row carries a reason control'
  );
  assert.strictEqual(
    doneRow(doc, published).querySelector('button.bghsa-done-save'),
    null,
    'a published row carries a control that would write a reason'
  );
});

/**
 * @param {Document} doc
 * @param {string} facet
 * @returns {Element} the control holding the completed list to one value of
 *   that facet. The bar carries the open list's filters beside these, and both
 *   surfaces have a `state` facet, so the query names whose controls these are.
 */
function filterIn(doc, facet) {
  return one(doc, `#${table.ROOT_ID} .bghsa-done-controls [${table.FACET_ATTRIBUTE}="${facet}"]`);
}

/**
 * @param {Element} control
 * @returns {Element[]} the items its menu offers, in the order it offers them.
 */
function itemNodes(control) {
  return Array.from(control.querySelectorAll(`[${table.VALUE_ATTRIBUTE}]`));
}

/**
 * @param {Element} control
 * @returns {string} what its menu offers, as one line.
 */
function itemsOf(control) {
  return itemNodes(control)
    .map((item) => (item.textContent ?? '').trim())
    .join(' | ');
}

/**
 * Presses an item the way a maintainer does.
 *
 * @param {Document} doc
 * @param {string} facet
 * @param {string} value What the item holds the control to.
 * @returns {void}
 */
function pick(doc, facet, value) {
  for (const item of itemNodes(filterIn(doc, facet))) {
    if ((item.getAttribute(table.VALUE_ATTRIBUTE) ?? '') !== value) continue;
    /** @type {HTMLElement} */ (/** @type {unknown} */ (item)).click();
    return;
  }
  throw new Error(`the ${facet} filter offers no ${value === '' ? 'reset item' : value}`);
}

/**
 * @param {Document} doc
 * @returns {string} the identifiers the view is showing, in the order it shows
 *   them.
 */
function shownIds(doc) {
  return Array.from(doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`))
    .map((row) => row.getAttribute('data-bghsa-ghsa') ?? '')
    .join(' ');
}

/**
 * One advisory read carrying a maintainer's stored closure reason.
 *
 * @param {string} ghsaId
 * @param {string} state
 * @param {string | null} reason
 * @returns {import('../src/common/parse-detail.js').ParsedDetail}
 */
function ended(ghsaId, state, reason) {
  return advisory({
    ref: { ...REF, ghsaId },
    ghsaId,
    state,
    comments:
      reason === null
        ? []
        : [
            comment({
              id: '31',
              author: 'samuelkarp',
              raw: JSON.stringify({
                betterGhsa: '1.0',
                seq: 1,
                by: 'samuelkarp',
                at: '2026-04-01T00:00:00Z',
                closure: { reason },
              }),
            }),
          ],
  });
}

test('the severity filter is over the published rows', async () => {
  // REQUIREMENTS.md section 10: publication settles the rating and a closed
  // advisory carries no severity, so a level on a closed row means nothing and
  // that row falls out of every value of this filter.
  const high = ghsa('saaa');
  const low = ghsa('sbbb');
  const closed = ghsa('sccc');
  const doc = await page(
    await corpusOf([
      member({ ghsaId: high, state: 'published', severity: 'high' }),
      member({ ghsaId: low, state: 'published', severity: 'low' }),
      member({ ghsaId: closed, state: 'closed', severity: 'high' }),
    ])
  );

  assert.strictEqual(
    itemsOf(filterIn(doc, 'severity')),
    'Any | High | Low',
    'the filter offers the levels the published rows carry, highest first'
  );

  pick(doc, 'severity', 'High');
  assert.strictEqual(
    shownIds(doc),
    high,
    'a closed row carrying the same level was kept by it'
  );

  pick(doc, 'severity', 'Low');
  assert.strictEqual(shownIds(doc), low);

  pick(doc, 'severity', '');
  assert.strictEqual(shownIds(doc), [high, low, closed].join(' '));
});

test('the filters keep the rows they name and the count follows them', async () => {
  const first = ghsa('paaa');
  const second = ghsa('pbbb');
  const named = ghsa('xaaa');
  const bare = ghsa('xbbb');
  const unread = ghsa('xccc');
  const doc = await page(
    await corpusOf([
      member({ ghsaId: first, state: 'published', advisory: ended(first, 'Published', null) }),
      member({ ghsaId: second, state: 'published', advisory: ended(second, 'Published', null) }),
      member({ ghsaId: named, state: 'closed', advisory: ended(named, 'Closed', 'duplicate') }),
      member({ ghsaId: bare, state: 'closed', advisory: ended(bare, 'Closed', null) }),
      // The crawl found this one and nothing has read it.
      member({ ghsaId: unread, state: 'closed' }),
    ])
  );

  const count = `#${view.ROOT_ID} .bghsa-done-count`;
  assert.strictEqual(shownIds(doc), [first, second, named, bare, unread].sort().join(' '));
  assert.strictEqual(textOf(doc, count), '5 advisories', 'the header counts the whole list');

  assert.strictEqual(
    itemsOf(filterIn(doc, 'state')),
    'Any | Published | Closed',
    'the state filter offers the endings the rows are in'
  );
  assert.strictEqual(
    itemsOf(filterIn(doc, 'reason')),
    `Any | Duplicate | ${table.NO_VALUE}`,
    'the reason filter offers what the closed rows carry, and the absence of one'
  );

  pick(doc, 'state', 'Published');
  assert.strictEqual(shownIds(doc), [first, second].sort().join(' '));
  assert.strictEqual(
    textOf(doc, count),
    '2 of 5 advisories',
    'the header counts what the filters left'
  );

  pick(doc, 'state', 'Closed');
  assert.strictEqual(shownIds(doc), [named, bare, unread].sort().join(' '));

  pick(doc, 'state', '');
  assert.strictEqual(shownIds(doc), [first, second, named, bare, unread].sort().join(' '));
  assert.strictEqual(textOf(doc, count), '5 advisories');

  // A published row holds no reason and matches no value of one, so the reason
  // filter is over the closed advisories alone. A row nothing has read passes
  // every filter, because no value has been looked up that could exclude it.
  pick(doc, 'reason', 'Duplicate');
  assert.strictEqual(shownIds(doc), [named, unread].sort().join(' '));

  pick(doc, 'reason', table.NO_VALUE);
  assert.strictEqual(
    shownIds(doc),
    [bare, unread].sort().join(' '),
    'the closed advisories a reason has still to be set on'
  );

  // A press picks a value and shuts the menu it was made in, which is the box
  // being drawn again from what the filters are now holding the list to.
  filterIn(doc, 'state').setAttribute('open', '');
  pick(doc, 'state', 'Closed');
  assert.ok(!filterIn(doc, 'state').hasAttribute('open'), 'the menu a value was picked in stayed open');
  assert.strictEqual(
    textOf(filterIn(doc, 'state'), 'summary'),
    'State: Closed',
    'the control reads the value it is holding the list to'
  );
  pick(doc, 'state', '');

  // The reset is the way back, and it is offered from the unfiltered list.
  const reset = one(doc, `#${table.ROOT_ID} .bghsa-done-reset`);
  assert.strictEqual(reset.hasAttribute('disabled'), false, 'the reset is shut while a filter holds');
  /** @type {HTMLElement} */ (/** @type {unknown} */ (reset)).click();
  assert.strictEqual(shownIds(doc), [first, second, named, bare, unread].sort().join(' '));
  assert.ok(
    one(doc, `#${table.ROOT_ID} .bghsa-done-reset`).hasAttribute('disabled'),
    'the reset is offered from the list it goes back to'
  );
});

test('a list the filters keep no row of says so', async () => {
  const published = ghsa('qaaa');
  const closed = ghsa('qbbb');
  const doc = await page(
    await corpusOf([
      member({
        ghsaId: published,
        state: 'published',
        advisory: ended(published, 'Published', null),
      }),
      member({ ghsaId: closed, state: 'closed', advisory: ended(closed, 'Closed', 'duplicate') }),
    ])
  );

  // Each filter keeps the row the other drops.
  pick(doc, 'state', 'Published');
  pick(doc, 'reason', 'Duplicate');
  assert.strictEqual(shownIds(doc), '', 'the filters kept a row neither names');
  assert.strictEqual(
    textOf(doc, `#${view.ROOT_ID} .bghsa-done-empty`),
    table.EMPTY_TEXT,
    'the words the table uses for a filter that kept nothing'
  );
});

test("the completed filters sit on the bar with the open list's", async () => {
  const doc = await page(await corpusOf([member({ ghsaId: ghsa('taaa'), state: 'closed' })]));
  const bar = one(doc, `#${table.ROOT_ID} .bghsa-list-bar`);
  assert.ok(bar.querySelector('.bghsa-list-controls') !== null, "the open list's filters left the bar");
  assert.ok(bar.querySelector('.bghsa-done-controls') !== null, 'the completed filters are not on the bar');
  assert.strictEqual(
    doc.querySelector(`#${view.ROOT_ID} .bghsa-done-controls`),
    null,
    'the completed filters are inside the view the draw replaces'
  );

  /**
   * @param {string} selector
   * @returns {boolean} whether that control set is in view.
   */
  const shows = (selector) =>
    !one(doc, `#${table.ROOT_ID} ${selector}`).classList.contains(table.HIDDEN_CLASS);

  // One set is in view at a time, and it is the one that filters what is on
  // screen.
  assert.deepStrictEqual(
    [shows('.bghsa-list-controls'), shows('.bghsa-done-controls')],
    [true, false],
    'the table is showing'
  );
  table.setViewMode(doc, view.MODE);
  table.applyVisibility(doc);
  assert.deepStrictEqual(
    [shows('.bghsa-list-controls'), shows('.bghsa-done-controls')],
    [false, true],
    'the completed view is showing'
  );
  table.setViewMode(doc, table.VIEW_NATIVE);
  table.applyVisibility(doc);
  assert.deepStrictEqual(
    [shows('.bghsa-list-controls'), shows('.bghsa-done-controls')],
    [false, false],
    "GitHub's own view is showing"
  );
  table.setViewMode(doc, table.VIEW_TABLE);
  table.applyVisibility(doc);

  // Both surfaces have a State filter, and now both sets of controls stand in
  // one root. A read landing in the table brings the table's own filters up to
  // date and leaves the completed view's alone.
  const offered = itemsOf(filterIn(doc, 'state'));
  const read = parseDetail.parseDetail(document(fixture('triage-thread.html')));
  assert.ok(read !== null, 'the fixture reads as an advisory');
  await table.applyEntry(doc, TRIAGE_ID, { record: read, observedAt: clockAt, state: 'triage' });
  assert.strictEqual(
    itemsOf(filterIn(doc, 'state')),
    offered,
    "the completed view's State filter was filled with the table's own values"
  );
  assert.strictEqual(offered, 'Any | Closed', `the completed states offered: ${offered}`);
});

test('a read landing leaves the filter under the maintainer alone', async () => {
  const read = ghsa('raaa');
  const arriving = ghsa('rbbb');
  const doc = await page(
    await corpusOf([
      member({ ghsaId: read, state: 'closed', advisory: ended(read, 'Closed', null) }),
      member({ ghsaId: arriving, state: 'closed' }),
    ])
  );

  // The browser opens the menu on the press of its summary.
  const before = filterIn(doc, 'reason');
  const item = one(before, `[${table.VALUE_ATTRIBUTE}]`);
  before.setAttribute('open', '');
  view.draw(doc);

  const after = filterIn(doc, 'reason');
  assert.strictEqual(after, before, 'the draw built the control again under the maintainer');
  assert.strictEqual(
    one(after, `[${table.VALUE_ATTRIBUTE}]`),
    item,
    'the draw built the items of a menu nothing changed again'
  );
  assert.ok(after.hasAttribute('open'), 'the draw shut a menu that was open');
  assert.strictEqual(itemsOf(after), `Any | ${table.NO_VALUE}`);

  // A read that turns up a value the menu does not offer is what changes it,
  // and it changes the items and not the control they are in.
  const held = /** @type {import('../src/done/corpus.js').Corpus} */ (view.stateOf(doc).corpus);
  const landed = /** @type {import('../src/done/corpus.js').CorpusMember} */ (
    view.memberOf(held, arriving)
  );
  landed.advisory = ended(arriving, 'Closed', 'duplicate');
  held.unread = [];
  view.draw(doc);

  assert.strictEqual(
    itemsOf(filterIn(doc, 'reason')),
    `Any | Duplicate | ${table.NO_VALUE}`,
    'the value the read turned up is offered'
  );
  assert.strictEqual(filterIn(doc, 'reason'), before, 'and the control it is offered in is the same one');
  assert.ok(filterIn(doc, 'reason').hasAttribute('open'), 'which is still open');
});

test('the observed cell reads the same words the list rows read', async () => {
  const unread = ghsa('dddd');
  const read = ghsa('dddf');
  const doc = await page(
    await corpusOf([
      member({ ghsaId: unread, state: 'closed' }),
      member({
        ghsaId: read,
        state: 'published',
        advisory: advisory({ ref: { ...REF, ghsaId: read }, ghsaId: read, state: 'Published' }),
      }),
    ])
  );

  const cell = '.bghsa-done-observed';
  assert.strictEqual(
    textOf(doneRow(doc, unread), cell),
    'Not read',
    'a row no advisory read backs says so in the words the table uses'
  );
  const seen = textOf(doneRow(doc, read), cell);
  assert.ok(seen.startsWith('Observed '), `the read row reads: ${seen}`);
  assert.strictEqual(
    seen,
    table.observedTextOf({ read: true, observedAt: Date.parse('2026-08-27T09:00:00Z') }),
    'and it is built by the same function the list rows are'
  );
});

test('the header says a list will stay short when nothing is filling it', async () => {
  const members = [member({ ghsaId: ghsa('eeff'), state: 'closed', severity: 'high' })];
  const header = `#${view.ROOT_ID} .bghsa-done-header span.Label`;

  // A corpus the walk assembled goes on saying it is being filled, and this
  // page has no collection running. What is missing is not on its way, and the
  // corpus saying otherwise does not make it so.
  const doc = await page(corpusOf(members, { complete: false, running: true }));
  assert.deepStrictEqual(textsOf(doc, header), ['Failed to load all advisories']);

  view.setState(doc, { corpus: corpusOf(members, { complete: false, running: false }) });
  view.draw(doc);
  assert.deepStrictEqual(textsOf(doc, header), ['Failed to load all advisories']);

  // A walk that reached the last page of both states says nothing.
  view.setState(doc, { corpus: corpusOf(members, { complete: true, running: false }) });
  view.draw(doc);
  assert.deepStrictEqual(textsOf(doc, header), []);
});

test('the header counts what a running crawl has still to read', async () => {
  const ids = [ghsa('vaaa'), ghsa('vbbb'), ghsa('vccc')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids,
    counts: { published: 3, closed: 0 },
  });
  pages[`${base}?state=closed`] = listHtml({
    state: 'closed',
    ids: [],
    counts: { published: 3, closed: 0 },
  });
  for (const id of ids) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  await cache.clear();
  const doc = await page();
  /** @type {string[]} */
  const said = [];
  const record = async () => {
    said.push(textsOf(doc, `#${view.ROOT_ID} .bghsa-done-header span.Label`).join('+'));
  };
  during[`${base}?state=published`] = record;
  during[`${base}?state=closed`] = record;
  for (const id of ids) during[detailUrl(id)] = record;
  await view.collect(doc, QUEUE_OPTIONS);

  // What the header said while each of those five requests was out. The walk
  // has no count to give, because it is what finds out how many there are. From
  // the first read landing the chip counts what the queue has still to read, so
  // a crawl that is working can be told from one that has stopped. The words
  // are the ones the open list's own header carries.
  assert.deepStrictEqual(said, [
    table.WALKING_TEXT,
    table.WALKING_TEXT,
    table.WALKING_TEXT,
    'Loading (2 left)...',
    'Loading (1 left)...',
  ]);
  assert.deepStrictEqual(
    textsOf(doc, `#${view.ROOT_ID} .bghsa-done-header span.Label`),
    [],
    'the header still says the crawl is running'
  );
});

test('the header keeps up while the queue serves the open list', async () => {
  const done = [ghsa('yaaa'), ghsa('ybbb')];
  const open = [ghsa('zaaa'), ghsa('zbbb'), ghsa('zccc')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: done,
    counts: { published: 2, closed: 0 },
  });
  pages[`${base}?state=closed`] = listHtml({ state: 'closed', ids: [], counts: { published: 2, closed: 0 } });
  for (const id of [...done, ...open]) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  await cache.clear();
  const doc = await page();
  const { queue } = table.queueFor(REF, QUEUE_OPTIONS);

  /** @type {string[]} */
  const said = [];
  const record = async () => {
    said.push(textsOf(doc, `#${view.ROOT_ID} .bghsa-done-header span.Label`).join('+'));
  };
  during[detailUrl(done[0] ?? '')] = async () => {
    // The open list's refresh queues its reads through the one queue this
    // repository has, while this collection is running.
    await queue.add([...open]);
    await record();
  };
  for (const id of [done[1], ...open]) during[detailUrl(id ?? '')] = record;

  await view.collect(doc, QUEUE_OPTIONS);

  // What the header said while each of those five reads was out: this view's
  // two advisories, then the open list's three. The number is what the one
  // queue has still to read, so every read moves it, whichever surface asked
  // for it, and what is on screen is what is true.
  assert.deepStrictEqual(said, [
    table.WALKING_TEXT,
    'Loading (4 left)...',
    'Loading (3 left)...',
    'Loading (2 left)...',
    'Loading (1 left)...',
  ]);
  assert.deepStrictEqual(
    textsOf(doc, `#${view.ROOT_ID} .bghsa-done-header span.Label`),
    [],
    'the header still says the queue has reading to do'
  );
});

test('the header stops saying it is loading when the collection is put down', async () => {
  // GitHub re-renders the frame while a collection is running. A render pass
  // lands on the page mid-swap, reads no advisory list, and the list surface
  // tells every surface the page names no repository, which puts the
  // collection down. The header has to stop saying a collection is running,
  // because none is and nothing will move it again.
  const ids = [ghsa('haaa'), ghsa('hbbb'), ghsa('hccc')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids,
    counts: { published: 3, closed: 0 },
  });
  pages[`${base}?state=closed`] = listHtml({ state: 'closed', ids: [], counts: { published: 3 } });
  for (const id of ids) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  await cache.clear();

  const doc = await page();
  const held = one(doc, '#repo-content-turbo-frame').innerHTML;
  doneToggle(doc).click();

  during[detailUrl(ids[1] ?? '')] = async () => {
    // The frame is empty for a moment, and a pass runs while it is.
    one(doc, '#repo-content-turbo-frame').innerHTML = '';
    await table.render(doc);
    table.ensureRefresh(doc, QUEUE_OPTIONS);
    // GitHub finishes the swap and the next pass finds the page again.
    one(doc, '#repo-content-turbo-frame').innerHTML = held;
    await table.render(doc);
  };

  await view.collect(doc, QUEUE_OPTIONS);
  const status = `#${view.ROOT_ID} .bghsa-done-header span.Label`;
  assert.deepStrictEqual(
    textsOf(doc, status),
    [],
    'the header says a collection is running after it was put down'
  );
  assert.strictEqual(view.stateOf(doc).reading, false, 'the view holds a collection that is gone');

  // The collection was put down with a read still queued. It is taken back
  // here, so what this test left behind is not spent by the next one.
  const { queue } = table.queueFor(REF, QUEUE_OPTIONS);
  await queue.load();
  await queue.run();
});

test('the header stands from the ask and counts down while the walk waits', async () => {
  // One queue serves the repository and serves it in order. The open list's
  // refresh is running when the view is opened, so this collection's walk waits
  // behind every read the queue already holds, and those reads land while this
  // view has no corpus and no rows of its own. What the maintainer has to see
  // through that wait is a number that moves.
  const open = [ghsa('kaaa'), ghsa('kbbb'), ghsa('kccc'), ghsa('kddd')];
  const done = [ghsa('laaa')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({ state: 'published', ids: done, counts: { published: 1 } });
  pages[`${base}?state=closed`] = listHtml({ state: 'closed', ids: [], counts: { published: 1 } });
  for (const id of [...open, ...done]) {
    pages[detailUrl(id)] = detailHtml({ ghsaId: id, state: 'Published', reportedAt: '2026-03-02T00:00:00Z' });
  }
  await cache.clear();
  const doc = await page();
  const { queue } = table.queueFor(REF, QUEUE_OPTIONS);
  await queue.load();
  await queue.add([...open]);

  /** @type {string[]} */
  const said = [];
  /** @param {string} at @returns {void} */
  const record = (at) => {
    const chip = textsOf(doc, `#${view.ROOT_ID} .bghsa-done-header span.Label`).join('+');
    const rows = doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`).length;
    const held = view.stateOf(doc).corpus;
    said.push(`${at}: ${chip === '' ? 'no chip' : chip} rows=${rows} corpus=${held === null ? 'null' : held.members.length}`);
  };
  open.forEach((id, at) => {
    during[detailUrl(id)] = async () => record(`open read ${at + 1}`);
  });
  during[detailUrl(done[0] ?? '')] = async () => record('its own read');
  during[`${base}?state=published`] = async () => record('its own walk');

  // The open list's refresh is already running when the view is opened.
  const refreshing = queue.run();
  doneToggle(doc).click();
  record('the ask');
  await view.collect(doc, QUEUE_OPTIONS);
  await refreshing;
  record('the end');

  // The chip stands from the ask, and every read the queue takes off its list
  // lowers the count, whether or not this view has a row for it. The walk goes
  // out once the queue is drained, and from there the collection's own reads
  // fill the rows.
  assert.deepStrictEqual(said, [
    'the ask: Loading (4 left)... rows=0 corpus=null',
    'open read 1: Loading (4 left)... rows=0 corpus=null',
    'open read 2: Loading (3 left)... rows=0 corpus=null',
    'open read 3: Loading (2 left)... rows=0 corpus=null',
    'open read 4: Loading (1 left)... rows=0 corpus=null',
    'its own walk: Loading... rows=0 corpus=0',
    'its own read: Loading... rows=1 corpus=1',
    'the end: no chip rows=1 corpus=1',
  ]);
});

test('the count carries the read the queue has in flight', async () => {
  // The view is opened while a read is out. Three advisories were queued, one
  // of them is the request in flight and two are waiting, so what the queue has
  // left to read is three, and the chip drawn at that moment says three.
  const open = [ghsa('faaa'), ghsa('fbbb'), ghsa('fccc')];
  const held = ghsa('gaaa');
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: [held],
    counts: { published: 1 },
  });
  pages[`${base}?state=closed`] = listHtml({ state: 'closed', ids: [], counts: { published: 1 } });
  for (const id of [...open, held]) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  await cache.clear();
  const doc = await page();
  const { queue } = table.queueFor(REF, QUEUE_OPTIONS);
  await queue.load();
  await queue.add([...open]);

  /** @type {string[]} */
  const said = [];
  during[detailUrl(open[0] ?? '')] = async () => {
    doneToggle(doc).click();
    said.push(textsOf(doc, `#${view.ROOT_ID} .bghsa-done-header span.Label`).join('+'));
  };

  const refreshing = queue.run();
  await view.collect(doc, QUEUE_OPTIONS);
  await refreshing;

  assert.deepStrictEqual(said, ['Loading (3 left)...'], 'the read in flight went uncounted');
});

test('the list reads as loading until the first page of the walk lands', async () => {
  const doc = await page();
  view.setState(doc, { corpus: null, ref: REF, reading: true });
  view.draw(doc);
  assert.strictEqual(textOf(doc, `#${view.ROOT_ID} .bghsa-done-empty`), 'Loading...');

  // A collection that landed and found nothing is a repository with no done
  // advisory, which is not a repository still loading.
  view.setState(doc, { corpus: corpusOf([]), reading: false });
  view.draw(doc);
  assert.strictEqual(textOf(doc, `#${view.ROOT_ID} .bghsa-done-empty`), 'Not found');
  view.setState(doc, { corpus: null, ref: null });
});

/**
 * One comment on an advisory thread, in the shape the merge reads. A raw
 * payload makes it a state comment; no payload makes it an ordinary comment.
 *
 * @param {{ id: string, author: string, raw?: string }} fields
 * @returns {import('../src/common/parse-detail.js').ParsedComment}
 */
function comment(fields) {
  return {
    id: fields.id,
    elementId: `advisory-comment-${fields.id}`,
    author: fields.author,
    role: 'Member',
    roles: ['Member'],
    at: '2026-04-01T00:00:00Z',
    trusted: true,
    text: '',
    stateComment: fields.raw === undefined ? null : schema.readSnapshot(fields.raw),
  };
}

test('the reason an advisory carries is the reason its row shows', async () => {
  // The completed view exists to record and show a closure reason. Every other
  // test here reaches the reason through a control a maintainer moved, or
  // through a fixture that carries none, so the wiring from the advisory's own
  // stored state to the row it is drawn on is what this asserts.
  const closed = ghsa('gghh');
  const held = advisory({
    ref: { ...REF, ghsaId: closed },
    ghsaId: closed,
    state: 'Closed',
    comments: [
      comment({
        id: '77',
        author: 'samuelkarp',
        raw: JSON.stringify({
          betterGhsa: '1.0',
          seq: 1,
          by: 'samuelkarp',
          at: '2026-04-01T00:00:00Z',
          closure: { reason: 'not reproducible' },
        }),
      }),
    ],
  });
  const corpus = corpusOf([member({ ghsaId: closed, state: 'closed', advisory: held })]);

  assert.strictEqual(
    view.rowsOf(corpus).find((row) => row.ghsaId === closed)?.closureReason,
    'not reproducible',
    'the row the view builds carries no reason off the advisory'
  );

  const doc = await page(corpus);
  const control = one(doneRow(doc, closed), 'select.bghsa-done-reason');
  const chosen = Array.from(control.querySelectorAll('option'))
    .filter((option) => option.hasAttribute('selected'))
    .map((option) => option.getAttribute('value'));
  assert.deepStrictEqual(chosen, ['not reproducible'], 'the control shows another reason');
});

test('a row says what its advisory duplicates, and links it where it can', async () => {
  // The reason alone does not say which advisory this one repeats, so the row
  // carries the pointer the panel carries and reaches it the same way.
  const linked = ghsa('dupa');
  const loose = ghsa('dupb');
  const pulled = ghsa('dupc');

  /**
   * @param {string} ghsaId
   * @param {string} duplicateOf
   * @returns {import('../src/done/corpus.js').CorpusMember}
   */
  const closedAs = (ghsaId, duplicateOf) =>
    member({
      ghsaId,
      state: 'closed',
      advisory: advisory({
        ref: { ...REF, ghsaId },
        ghsaId,
        state: 'Closed',
        comments: [
          comment({
            id: '81',
            author: 'samuelkarp',
            raw: JSON.stringify({
              betterGhsa: '1.0',
              seq: 1,
              by: 'samuelkarp',
              at: '2026-04-01T00:00:00Z',
              closure: { reason: 'duplicate', duplicateOf },
            }),
          }),
        ],
      }),
    });

  const corpus = corpusOf([
    closedAs(linked, 'GHSA-cm76-qm8v-3j95'),
    closedAs(loose, 'the one <prakleumas> filed last March'),
    closedAs(pulled, 'https://github.com/containerd/containerd/pull/13327'),
  ]);
  assert.strictEqual(
    view.rowsOf(corpus).find((row) => row.ghsaId === linked)?.closureDuplicateOf,
    'GHSA-cm76-qm8v-3j95',
    'the row the view builds carries nothing off the advisory'
  );

  const doc = await page(corpus);
  const pointer = one(doneRow(doc, linked), '.bghsa-done-duplicate');
  assert.strictEqual(pointer.textContent?.trim(), 'of GHSA-cm76-qm8v-3j95');
  assert.strictEqual(
    one(pointer, 'a').getAttribute('href'),
    `/${REF.owner}/${REF.repo}/security/advisories/GHSA-cm76-qm8v-3j95`
  );

  const plain = one(doneRow(doc, loose), '.bghsa-done-duplicate');
  assert.strictEqual(plain.textContent?.trim(), 'of the one prakleumas filed last March');
  assert.strictEqual(
    plain.querySelector('a'),
    null,
    'a value nobody can interpret stands as the text it is'
  );

  // A pull request of another repository, which is how one arrives in practice.
  const pull = one(doneRow(doc, pulled), '.bghsa-done-duplicate');
  assert.strictEqual(pull.textContent?.trim(), 'of containerd/containerd#13327');
  assert.strictEqual(
    one(pull, 'a').getAttribute('href'),
    '/containerd/containerd/pull/13327'
  );
});

test('the duplicate pointer stands under the reason control', async () => {
  // Beside the control the pointer adds its own width to the closure cell, and
  // that cell holds every row's control in one column. Under it, the column
  // stands where the rows with no pointer keep it.
  const closed = ghsa('dupd');
  const doc = await page(
    await corpusOf([
      member({
        ghsaId: closed,
        state: 'closed',
        advisory: advisory({
          ref: { ...REF, ghsaId: closed },
          ghsaId: closed,
          state: 'Closed',
          comments: [
            comment({
              id: '82',
              author: 'samuelkarp',
              raw: JSON.stringify({
                betterGhsa: '1.0',
                seq: 1,
                by: 'samuelkarp',
                at: '2026-04-01T00:00:00Z',
                closure: { reason: 'duplicate', duplicateOf: 'GHSA-cm76-qm8v-3j95' },
              }),
            }),
          ],
        }),
      }),
    ])
  );

  const closure = one(doneRow(doc, closed), '.bghsa-done-closure');
  assert.deepStrictEqual(
    Array.from(closure.children).map((child) => child.getAttribute('class')),
    [
      'd-flex flex-items-center bghsa-done-closure-controls',
      'mt-1 text-small bghsa-done-duplicate-line',
    ],
    'the closure cell is the controls on one line and the pointer under them'
  );
  const controls = one(closure, '.bghsa-done-closure-controls');
  assert.ok(
    controls.querySelector('select.bghsa-done-reason') !== null &&
      controls.querySelector('button.bghsa-done-save') !== null,
    'the select and Save share the first line'
  );
  assert.strictEqual(
    controls.querySelector('.bghsa-done-duplicate'),
    null,
    'the pointer stands on a line of its own'
  );
  // A value with no break in it wraps inside a line the control is wider than,
  // so the widest thing in the cell is the control.
  assert.ok(
    view.STYLE_TEXT.includes('.bghsa-done-duplicate-line {') &&
      view.STYLE_TEXT.includes('max-width: 12rem') &&
      view.STYLE_TEXT.includes('overflow-wrap: anywhere'),
    'no rule bounds the pointer line'
  );
});

test('the option for an advisory carrying no reason reads blank', async () => {
  const closed = ghsa('ubbb');
  const doc = await page(
    await corpusOf([
      member({
        ghsaId: closed,
        state: 'closed',
        advisory: advisory({ ref: { ...REF, ghsaId: closed }, ghsaId: closed, state: 'Closed' }),
      }),
    ])
  );

  const control = one(doneRow(doc, closed), 'select.bghsa-done-reason');
  const empty = one(control, 'option[value=""]');
  assert.strictEqual(empty.textContent, '', 'the option for no reason reads words of its own');
  assert.ok(empty.hasAttribute('selected'), 'a row nobody has set a reason on shows another option');
  assert.strictEqual(
    control.getAttribute('aria-label'),
    'Closure reason',
    'the control a reader cannot see is unnamed'
  );
});

test('an advisory this view reads teaches the owner and backport pickers', async () => {
  // The panel offers the logins it has seen carrying a member badge and the
  // release branches it has seen on the repository. Both are read off an
  // advisory, and the advisories here are ones the crawl read rather than ones
  // a maintainer opened, so what this view reads is worth the same.
  members.clear();
  branches.clear();
  const read = parseDetail.parseDetail(document(fixture('triage-thread.html')));
  assert.ok(read !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const built = view.memberOf(held, TRIAGE_ID)?.advisory ?? null;
  assert.ok(built !== null, 'the cached entry read back as an advisory');
  const key = edit.keyOf(built);
  const doc = await page(held);
  try {
    assert.deepStrictEqual(members.known(REF), [], 'a row drawn is not an advisory read');

    choose(one(doneRow(doc, TRIAGE_ID), 'select.bghsa-done-reason'), 'not a vulnerability');
    await settled();
    assert.deepStrictEqual(
      members.known(REF),
      ['samuelkarp'],
      'the member badges on this advisory were dropped'
    );
    assert.deepStrictEqual(
      branches.known(REF),
      ['release/1.0'],
      'the release branches this advisory names were dropped'
    );
  } finally {
    edit.edits.delete(key);
    members.clear();
    branches.clear();
  }
});

test('a closure reason picked here and put back leaves nothing staged', async () => {
  const read = parseDetail.parseDetail(document(fixture('triage-thread.html')));
  assert.ok(read !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const built = view.memberOf(held, TRIAGE_ID)?.advisory ?? null;
  assert.ok(built !== null, 'the cached entry read back as an advisory');
  const key = edit.keyOf(built);
  const doc = await page(held);
  const row = doneRow(doc, TRIAGE_ID);
  const control = one(row, 'select.bghsa-done-reason');
  const save = one(row, 'button.bghsa-done-save');
  assert.ok(save.hasAttribute('disabled'), 'Save is offered before the select moves');

  choose(control, 'not a vulnerability');
  await settled();
  assert.strictEqual(edit.editsFor(key).closureReason, 'not a vulnerability');
  assert.strictEqual(edit.anyPending(), true, 'a reason picked here is not unsaved work');
  assert.ok(!save.hasAttribute('disabled'), 'Save stayed shut after the select moved');
  assert.strictEqual(save.getAttribute('aria-disabled'), null);

  // Back to the reason the advisory carries, which this fixture does not have.
  choose(control, '');
  await settled();
  assert.strictEqual(
    edit.editsFor(key).closureReason,
    undefined,
    'a reason put back where it started stayed staged'
  );
  assert.strictEqual(edit.anyPending(), false, 'a reason put back where it started warns on leaving');
  assert.ok(
    save.hasAttribute('disabled'),
    'Save is still offered with the select back where it started'
  );
  assert.strictEqual(save.getAttribute('aria-disabled'), 'true');
  edit.edits.delete(key);
});

test('a closure reason set here goes out through the stored write path', async () => {
  const read = parseDetail.parseDetail(document(fixture('triage-thread.html')));
  assert.ok(read !== null && read.ref !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const built = view.memberOf(held, TRIAGE_ID)?.advisory ?? null;
  assert.ok(built !== null, 'the cached entry read back as an advisory');
  assert.notStrictEqual(built, read, 'the member carries the read back, not the parse');
  assert.strictEqual(built.ref?.owner, REF.owner, 'which names the repository it is on');
  assert.strictEqual(built.ref?.ghsaId, TRIAGE_ID, 'and the advisory it is of');
  const doc = await page(held);

  const row = doneRow(doc, TRIAGE_ID);
  const control = one(row, 'select.bghsa-done-reason');
  const save = one(row, 'button.bghsa-done-save');
  assert.ok(
    save.hasAttribute('disabled'),
    'Save is offered on a row whose reason nobody has picked'
  );
  assert.deepStrictEqual(
    Array.from(control.querySelectorAll('option')).map((node) => node.getAttribute('value')),
    ['', ...schema.CLOSURE_REASONS],
    'the control offers the reasons the schema knows'
  );

  choose(control, 'not a vulnerability');
  await settled();
  assert.ok(
    !save.hasAttribute('disabled'),
    'a member the cache backs cannot be written from here once its reason moves'
  );

  /** @type {import('../src/detail/edit.js').EditorContext[]} */
  const saved = [];
  /** @type {() => void} */
  let landed = () => {};
  const asked = new Promise((resolve) => {
    landed = () => resolve(undefined);
  });
  const realSave = edit.save;
  edit.save = async (context) => {
    saved.push(context);
    landed();
    return {
      ok: true,
      reason: null,
      status: 200,
      message: 'saved',
      snapshot: null,
      merged: null,
      advisory: null,
      readAt: null,
    };
  };
  try {
    /** @type {HTMLElement} */ (/** @type {unknown} */ (save)).click();
    await Promise.race([
      asked,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no save was asked for')), 2000)),
    ]);
  } finally {
    edit.save = realSave;
  }

  assert.strictEqual(saved.length, 1, 'the press went to the editing store, not to a writer here');
  const context = /** @type {import('../src/detail/edit.js').EditorContext} */ (saved[0]);
  assert.strictEqual(context.advisory, built, 'the save is against the advisory the view holds');
  const key = edit.keyOf(built);
  assert.strictEqual(
    key,
    `${REF.owner}/${REF.repo}/${TRIAGE_ID}`.toLowerCase(),
    'staged under the key the detail panel uses, so one advisory has one entry'
  );
  assert.strictEqual(edit.editsFor(key).closureReason, 'not a vulnerability');
  // The snapshot that write would carry, built by the writer's own builder.
  assert.deepStrictEqual(
    edit.changesOf(context.tracking, context.fingerprints, edit.editsFor(key), {
      by: 'samuelkarp',
      at: '2026-08-27T12:00:00Z',
    }),
    { closure: { reason: 'not a vulnerability' } }
  );
  edit.edits.delete(key);
});

test('a reason a maintainer sets reaches GitHub as a state comment', async () => {
  const page_html = fixture('triage-thread.html');
  const read = parseDetail.parseDetail(document(page_html));
  assert.ok(read !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const built = view.memberOf(held, TRIAGE_ID)?.advisory ?? null;
  assert.ok(built !== null, 'the cached entry read back as an advisory');
  const doc = await page(held);

  /** @type {URLSearchParams[]} */
  const posted = [];
  const outcome = await view.setReason(doc, TRIAGE_ID, 'out of scope', {
    fetch: async (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { status: 200, text: async () => page_html };
      const body = /** @type {URLSearchParams} */ (/** @type {unknown} */ (init.body));
      posted.push(body);
      const markdown = body.get('body') ?? body.get(write.EDIT_BODY_FIELD) ?? '';
      const marker = /`([^`\n]+)`/.exec(markdown)?.[1] ?? '';
      const fence = /```json\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? '';
      const escape = /** @param {string} value */ (value) =>
        value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return {
        status: 200,
        text: async () =>
          '<!doctype html><html><body>' +
          '<div class="comment-body markdown-body js-comment-body"><details>' +
          `<summary>${schema.STATE_COMMENT_SUMMARY}</summary>` +
          `<p><code>${escape(marker)}</code></p>` +
          `<div class="highlight highlight-source-json"><pre>${escape(fence)}</pre></div>` +
          '</details></div></body></html>',
      };
    },
    parseDocument: (html) => document(html),
  });

  assert.ok(outcome !== null && outcome.ok, `the write: ${outcome?.message}`);
  assert.strictEqual(posted.length, 1, 'one comment went out');
  const markdown = posted[0]?.get('body') ?? posted[0]?.get(write.EDIT_BODY_FIELD) ?? '';
  const snapshot = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(markdown)?.[1] ?? '{}');
  assert.deepStrictEqual(
    snapshot.closure,
    { reason: 'out of scope' },
    `the snapshot GitHub was sent: ${markdown}`
  );

  // The corpus holds the advisory as the crawl read it, which is a page from
  // before this write. The row shows the reason the write landed.
  const shown = Array.from(
    one(doneRow(doc, TRIAGE_ID), 'select.bghsa-done-reason').querySelectorAll('option')
  )
    .filter((option) => option.hasAttribute('selected'))
    .map((option) => option.getAttribute('value'));
  assert.deepStrictEqual(shown, ['out of scope'], 'the control shows the reason the save wrote');

  edit.edits.delete(edit.keyOf(built));
  edit.written.delete(edit.keyOf(built));
  edit.results.delete(edit.keyOf(built));
});

test('the closure controls are held still while a save is out', async () => {
  const read = parseDetail.parseDetail(document(fixture('triage-thread.html')));
  assert.ok(read !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const doc = await page(held);

  /** @type {() => void} */
  let land = () => {};
  const landed = new Promise((resolve) => {
    land = () => resolve(undefined);
  });
  /** @type {import('../src/detail/edit.js').EditorContext[]} */
  const saved = [];
  const realSave = edit.save;
  edit.save = async (context) => {
    saved.push(context);
    await landed;
    return {
      ok: true,
      reason: null,
      status: 200,
      message: 'saved',
      snapshot: null,
      merged: null,
      advisory: null,
      readAt: null,
    };
  };
  try {
    const flight = view.setReason(doc, TRIAGE_ID, 'out of scope');

    const during = doneRow(doc, TRIAGE_ID);
    assert.ok(
      one(during, 'select.bghsa-done-reason').hasAttribute('disabled'),
      'the reason could be changed under the write carrying it'
    );
    assert.ok(
      one(during, 'button.bghsa-done-save').hasAttribute('disabled'),
      'a second press could land on the write in flight'
    );
    assert.strictEqual(textOf(during, '.bghsa-done-note'), 'Saving...');

    // A press the disabled control cannot make, made anyway.
    assert.strictEqual(
      await view.setReason(doc, TRIAGE_ID, 'not a vulnerability'),
      null,
      'a second save went out while the first was in flight'
    );

    land();
    const outcome = await flight;
    assert.ok(outcome !== null && outcome.ok, 'the save did not land');
    assert.strictEqual(saved.length, 1, 'more than one save went out');
  } finally {
    edit.save = realSave;
  }

  const after = doneRow(doc, TRIAGE_ID);
  assert.ok(
    !one(after, 'select.bghsa-done-reason').hasAttribute('disabled'),
    'the flight kept the control it took'
  );
  assert.ok(
    !one(after, 'button.bghsa-done-save').hasAttribute('disabled'),
    'the flight kept the button it took'
  );
  edit.edits.delete(edit.keyOf(/** @type {NonNullable<typeof read>} */ (read)));
  edit.results.delete(edit.keyOf(/** @type {NonNullable<typeof read>} */ (read)));
});

test('a press that changes no reason writes nothing and draws no note', async () => {
  // Save is shut with the select where it started, so no press reaches this
  // refusal. It is still what a save carrying nothing answers with, and it says
  // nothing, so the row shows nothing.
  const page_html = fixture('triage-thread.html');
  const read = parseDetail.parseDetail(document(page_html));
  assert.ok(read !== null, 'the fixture reads as an advisory');
  const held = await cachedCorpus([{ ghsaId: TRIAGE_ID, state: 'closed', record: read }]);
  const doc = await page(held);
  const stored = view.rowsOf(held).find((row) => row.ghsaId === TRIAGE_ID)?.closureReason ?? null;

  /** @type {string[]} */
  const calls = [];
  const outcome = await view.setReason(doc, TRIAGE_ID, stored, {
    fetch: async (_url, init) => {
      calls.push(init.method ?? 'GET');
      return { status: 200, text: async () => page_html };
    },
    parseDocument: (html) => document(html),
  });

  assert.ok(
    one(doneRow(doc, TRIAGE_ID), 'button.bghsa-done-save').hasAttribute('disabled'),
    'Save is offered on a row whose reason nobody moved'
  );
  assert.ok(outcome !== null && outcome.ok === false, 'a save with no change was taken');
  assert.strictEqual(outcome.reason, 'unchanged');
  assert.strictEqual(outcome.message, '');
  assert.strictEqual(calls.length, 0, 'a save with no change reached GitHub');
  assert.strictEqual(
    doneRow(doc, TRIAGE_ID).querySelector('.bghsa-done-note'),
    null,
    'the row drew a note with nothing in it'
  );
  edit.results.delete(edit.keyOf(read));
});

test('an advisory nothing has read takes no reason and says why', async () => {
  const doc = await page(await cachedCorpus([{ ghsaId: ghsa('iiii'), state: 'closed' }]));
  const row = doneRow(doc, ghsa('iiii'));
  assert.ok(
    one(row, 'button.bghsa-done-save').hasAttribute('disabled'),
    'the control cannot write what nothing has read'
  );

  const outcome = await view.setReason(doc, ghsa('iiii'), 'out of scope');
  assert.strictEqual(outcome, null, 'nothing was written');
  assert.strictEqual(
    textOf(doneRow(doc, ghsa('iiii')), '.bghsa-done-note'),
    'Error: cannot set reason'
  );
  view.notes.clear();
});

test('a second visit to the done view spends no request on the corpus', async () => {
  const published = [ghsa('kkkk'), ghsa('llll')];
  const closed = [ghsa('mmmm')];
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: published,
    counts: { published: 2, closed: 1 },
  });
  pages[`${base}?state=closed`] = listHtml({
    state: 'closed',
    ids: closed,
    counts: { published: 2, closed: 1 },
  });
  for (const id of published) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  for (const id of closed) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Closed',
      reportedAt: '2026-04-05T00:00:00Z',
    });
  }

  // An earlier test in this file walked these states through the same storage,
  // and a walk inside its threshold is not walked again. This is the first
  // visit a maintainer with an empty cache makes.
  await cache.clear();

  const first = await page();
  const before = asked.length;
  await view.collect(first);
  assert.strictEqual(
    asked.length - before,
    published.length + closed.length + 2,
    'the first visit reads both list pages and every advisory they name'
  );

  // The maintainer comes back an hour later: another page load, another
  // document, and the cache the first visit filled. On one five-minute
  // threshold this is the whole corpus again, at a request a second.
  clockAt += 60 * MINUTE;
  const second = await page();
  const at = asked.length;
  const held = await view.collect(second);
  assert.strictEqual(asked.length - at, 0, `the second visit asked for ${asked.slice(at)}`);
  assert.strictEqual(held?.members.length, 3, 'and it still drew the whole corpus');
  assert.deepStrictEqual(held?.unread, [], 'every row backed by a read, from the cache alone');
});

test("a corpus is not drawn under the repository the maintainer moved to", async () => {
  const other = { owner: 'git-utensils', repo: 'Fork-Knife' };
  const doc = await page(await cachedCorpus([{ ghsaId: ghsa('nnnn'), state: 'closed' }]));
  assert.strictEqual(
    doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`).length,
    1,
    'the corpus is drawn on the repository it was collected on'
  );
  assert.strictEqual(table.refOf(doc)?.repo, REF.repo, 'which is the one the page names');

  // GitHub replaces the turbo frame on a soft navigation and keeps the
  // document. The page now names another repository.
  one(doc, '#repo-content-turbo-frame').innerHTML = listHtml({
    state: 'published',
    ids: [ghsa('oooo')],
  }).replaceAll(`/${REF.owner}/${REF.repo}/`, `/${other.owner}/${other.repo}/`);
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');
  assert.strictEqual(table.refOf(doc)?.repo, other.repo, 'the page names the repository moved to');

  assert.strictEqual(
    doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`).length,
    0,
    "the previous repository's rows are drawn under the new page"
  );
  assert.strictEqual(
    textOf(doc, `#${view.ROOT_ID} .bghsa-done-count`),
    '0 advisories',
    'and its count with them'
  );
  assert.strictEqual(view.stateOf(doc).corpus, null, 'the view is still holding them');
});

test('a page or a read the crawl could not take shows a banner', async () => {
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  const closedUrl = `${base}?state=closed`;
  const readable = ghsa('pppp');
  const unreadable = ghsa('qqqq');
  const alsoUnreadable = ghsa('rrrr');
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: [readable, unreadable, alsoUnreadable],
    counts: { published: 3, closed: 0 },
  });
  pages[detailUrl(readable)] = detailHtml({
    ghsaId: readable,
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  // The closed list page and two advisories are the pages GitHub does not
  // answer.
  delete pages[closedUrl];
  delete pages[detailUrl(unreadable)];
  delete pages[detailUrl(alsoUnreadable)];
  await cache.clear();

  const doc = await page();
  const held = await view.collect(doc);
  assert.ok(held !== null, 'the collection ran');

  const banner = one(doc, `#${view.ROOT_ID} .bghsa-done-banner`);
  const lines = textsOf(banner, '.bghsa-done-failure');
  assert.strictEqual(lines.length, 3, `the failures named: ${lines.join(' | ')}`);
  assert.strictEqual(
    banner.textContent ?? '',
    lines.join(''),
    'the banner is the failure lines and nothing above them'
  );
  assert.ok(
    lines.includes(`Failed to load ${closedUrl}`),
    `the list page that failed is named: ${lines.join(' | ')}`
  );
  assert.ok(
    lines.includes(`Failed to load ${unreadable}`) &&
      lines.includes(`Failed to load ${alsoUnreadable}`),
    `each advisory whose read failed is named: ${lines.join(' | ')}`
  );
  assert.deepStrictEqual(view.stateOf(doc).failures, lines, 'the view holds what it drew');
});

test('a second collection names the reads that failed in it', async () => {
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  const readable = ghsa('ssss');
  const unreadable = ghsa('tttt');
  for (const state of ['published', 'closed']) {
    pages[`${base}?state=${state}`] = listHtml({
      state,
      ids: state === 'published' ? [readable, unreadable] : [],
      counts: { published: 2, closed: 0 },
    });
  }
  pages[detailUrl(readable)] = detailHtml({
    ghsaId: readable,
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  delete pages[detailUrl(unreadable)];
  await cache.clear();

  const doc = await page();
  assert.ok((await view.collect(doc)) !== null, 'the first collection ran');
  assert.deepStrictEqual(
    view.stateOf(doc).failures,
    [`Failed to load ${unreadable}`],
    'the first collection named the read that failed'
  );

  // GitHub answers the advisory this time, so the second collection has no
  // failure of its own. The queue is the same one, and it holds what the pass
  // before it could not read.
  pages[detailUrl(unreadable)] = detailHtml({
    ghsaId: unreadable,
    state: 'Published',
    reportedAt: '2026-03-03T00:00:00Z',
  });
  assert.ok((await view.collect(doc)) !== null, 'the second collection ran');
  assert.deepStrictEqual(view.stateOf(doc).failures, [], 'the second collection named a failure');
  assert.strictEqual(
    doc.querySelector(`#${view.ROOT_ID} .bghsa-done-banner`),
    null,
    'a collection that read everything drew a banner'
  );
});

test('a collection that resumes names only what it could not read', async () => {
  const failing = ghsa('zdzd');
  const other = ghsa('zeze');
  pages[listUrl(REF, 'published')] = listHtml({
    state: 'published',
    ids: [failing, other],
    counts: { published: 2, closed: 0 },
  });
  pages[listUrl(REF, 'closed')] = listHtml({
    state: 'closed',
    ids: [],
    counts: { published: 2, closed: 0 },
  });
  pages[detailUrl(other)] = detailHtml({
    ghsaId: other,
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  delete pages[detailUrl(failing)];
  await cache.clear();

  const doc = await page();
  // The maintainer follows a link out of the list while the advisory GitHub
  // will not answer is in flight. The pass stops there, with the other
  // advisory still to read and the failure in the progress the next page load
  // takes back.
  during[detailUrl(failing)] = async () => {
    await moveTo(doc, MOVED, [ghsa('zaaa')]);
    table.ensureRefresh(doc, QUEUE_OPTIONS);
  };
  await view.collect(doc, QUEUE_OPTIONS);
  const { queue } = table.queueFor(REF, QUEUE_OPTIONS);
  assert.deepStrictEqual(
    queue.progress().failed,
    [failing],
    'the stopped pass kept no record of the read that failed'
  );

  // The maintainer comes back, and GitHub answers the advisory it refused.
  pages[detailUrl(failing)] = detailHtml({
    ghsaId: failing,
    state: 'Published',
    reportedAt: '2026-03-03T00:00:00Z',
  });
  await moveTo(doc, REF, [failing, other]);
  assert.ok((await view.collect(doc, QUEUE_OPTIONS)) !== null, 'the collection ran');

  assert.deepStrictEqual(
    view.stateOf(doc).failures,
    [],
    'an advisory the collection read is named as one it could not'
  );
  assert.strictEqual(
    doc.querySelector(`#${view.ROOT_ID} .bghsa-done-banner`),
    null,
    'a collection that read everything drew a banner'
  );
  assert.deepStrictEqual(
    view.stateOf(doc).corpus?.unread,
    [],
    'the advisory the banner would name is drawn unread'
  );
});

/** The repository a soft navigation moves to in the tests below. */
const MOVED = { owner: 'git-utensils', repo: 'Fork-Knife' };

/**
 * Moves the page to another repository the way a soft navigation does: GitHub
 * replaces the turbo frame and keeps the document.
 *
 * @param {Document} doc
 * @param {{ owner: string, repo: string }} ref
 * @param {readonly string[]} ids What the list page there names.
 * @returns {Promise<void>}
 */
async function moveTo(doc, ref, ids) {
  one(doc, '#repo-content-turbo-frame').innerHTML = listHtml({
    state: 'published',
    ids: [...ids],
    counts: { published: ids.length, closed: 0 },
  }).replaceAll(`/${REF.owner}/${REF.repo}/`, `/${ref.owner}/${ref.repo}/`);
  if ((await table.render(doc)) === null) throw new Error('the page offered no anchor');
}

/**
 * @param {{ owner: string, repo: string }} ref
 * @param {string} state
 * @returns {string} the path that state's first list page is read from.
 */
function listUrl(ref, state) {
  return `/${ref.owner}/${ref.repo}/security/advisories?state=${state}`;
}

test('a collection that ends does not report the one now running finished', async () => {
  const left = ghsa('rrrr');
  const moved = ghsa('ssss');
  pages[listUrl(REF, 'published')] = listHtml({
    state: 'published',
    ids: [left],
    counts: { published: 1, closed: 0 },
  });
  pages[listUrl(REF, 'closed')] = listHtml({
    state: 'closed',
    ids: [],
    counts: { published: 1, closed: 0 },
  });
  pages[detailUrl(left)] = detailHtml({
    ghsaId: left,
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  await cache.clear();

  // The list page of the repository moved to is held until this test lets it
  // go, so the collection of that repository is still crawling when the
  // collection of the one left behind ends.
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => {
    release = () => {
      resolve(undefined);
    };
  });
  pages[listUrl(MOVED, 'published')] = listHtml({
    state: 'published',
    ids: [moved],
    counts: { published: 1, closed: 0 },
  }).replaceAll(`/${REF.owner}/${REF.repo}/`, `/${MOVED.owner}/${MOVED.repo}/`);
  during[listUrl(MOVED, 'published')] = () => held;

  const doc = await page();
  /** @type {Promise<unknown> | null} */
  let arriving = null;
  during[detailUrl(left)] = async () => {
    await moveTo(doc, MOVED, [moved]);
    arriving = view.collect(doc, QUEUE_OPTIONS);
  };

  await view.collect(doc, QUEUE_OPTIONS);
  assert.ok(arriving !== null, 'the collection of the repository moved to never started');

  assert.strictEqual(
    view.stateOf(doc).reading,
    true,
    'the collection that ended reported the one still crawling finished'
  );
  const drawn = (one(doc, `#${view.ROOT_ID}`).textContent ?? '').replace(/\s+/g, ' ');
  assert.ok(drawn.includes(view.LOADING_TEXT), `the view drew: ${drawn}`);
  assert.ok(!drawn.includes(view.EMPTY_TEXT), `the view drew: ${drawn}`);

  release();
  await arriving;
});

test('a collection spends no request on a repository the page has left', async () => {
  const published = [ghsa('tttt'), ghsa('uuuu'), ghsa('vvvv')];
  pages[listUrl(REF, 'published')] = listHtml({
    state: 'published',
    ids: published,
    counts: { published: published.length, closed: 1 },
  });
  pages[listUrl(REF, 'closed')] = listHtml({
    state: 'closed',
    ids: [ghsa('wwww')],
    counts: { published: published.length, closed: 1 },
  });
  for (const id of [...published, ghsa('wwww')]) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  await cache.clear();

  const doc = await page();
  const mine = `/${REF.owner}/${REF.repo}/`;
  // The maintainer follows a link out of the list while the walk is reading its
  // first page. The render that lands on the repository they moved to is what
  // tells this surface the page it was collecting for has gone.
  during[listUrl(REF, 'published')] = async () => {
    await moveTo(doc, MOVED, [ghsa('xxxx')]);
    table.ensureRefresh(doc, QUEUE_OPTIONS);
  };

  const before = asked.length;
  await view.collect(doc, QUEUE_OPTIONS);

  assert.deepStrictEqual(
    asked.slice(before).filter((url) => url.startsWith(mine)),
    [listUrl(REF, 'published')],
    'the collection carried on reading a repository nobody was looking at'
  );
  assert.strictEqual(
    view.stateOf(doc).reading,
    false,
    'the view reports a collection running that it put down'
  );

  // What the collection did not spend is what a maintainer coming back takes
  // up, and the walk it put down cost none of those reads twice.
  const back = asked.length;
  const { queue } = table.queueFor(REF, QUEUE_OPTIONS);
  await queue.load();
  await queue.run();
  assert.deepStrictEqual(
    asked.slice(back).filter((url) => url.startsWith(mine)).sort(),
    published.map(detailUrl).sort(),
    'the advisories the stopped pass was holding'
  );
});

test('a read that names no advisory offers no write from here', async () => {
  const read = parseDetail.parseDetail(document(fixture('triage-thread.html')));
  assert.ok(read !== null && read.ref !== null, 'the fixture reads as an advisory');
  // The reference comes off one region of the advisory page. A page laid out
  // without it still reads, still caches, and still reads back as an advisory,
  // and what it does not carry is the repository and the identifier a write
  // would go to.
  const held = await cachedCorpus([
    { ghsaId: TRIAGE_ID, state: 'closed', record: { ...read, ref: null } },
  ]);
  const built = view.memberOf(held, TRIAGE_ID)?.advisory ?? null;
  assert.ok(built !== null, 'the cached entry read back as an advisory');
  assert.strictEqual(built.ref, null, 'and it names no advisory to write on');

  const rows = view.rowsOf(held);
  assert.strictEqual(rows.length, 1, 'the member is a row');
  assert.strictEqual(rows[0]?.read, true, 'a read backs it');
  assert.strictEqual(rows[0]?.writable, false, 'and no write can be aimed at it');

  const doc = await page(held);
  assert.ok(
    one(doneRow(doc, TRIAGE_ID), 'button.bghsa-done-save').hasAttribute('disabled'),
    'the control offers a write that would have nowhere to go'
  );
});
