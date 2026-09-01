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
 * @returns {string[]} how each chip under one row's title is colored: every
 *   class on it other than `Label`, in the order it carries them.
 */
function chipColors(row) {
  return Array.from(row.querySelectorAll('.bghsa-done-chips span.Label')).map((label) =>
    (label.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name !== '' && name !== 'Label')
      .join(' ')
  );
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
    Array.from(rows).map(chipLine),
    ['Published High', 'Published High', 'Closed High'],
    'each row says which done state it is in'
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
        state: 'closed',
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
      member({ ghsaId: bare, state: 'closed', severity: 'low' }),
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

  assert.deepStrictEqual(chipLine(doneRow(doc, painted)), 'Closed Low');
  assert.deepStrictEqual(
    chipColors(doneRow(doc, painted)),
    ['Label--secondary bghsa-tone-done', 'Label--orange'],
    'a closed advisory reads purple beside a severity in its own color'
  );

  assert.deepStrictEqual(chipLine(doneRow(doc, read)), 'Published Moderate');
  assert.deepStrictEqual(
    chipColors(doneRow(doc, read)),
    ['Label--secondary bghsa-tone-success', 'Label--warning bghsa-fill'],
    'a published advisory reads green over a severity filled in the color the read supplied'
  );

  assert.deepStrictEqual(
    chipColors(doneRow(doc, bare)),
    ['Label--secondary bghsa-tone-done', 'Label--secondary'],
    'a severity GitHub carried no modifier on'
  );

  assert.deepStrictEqual(chipLine(doneRow(doc, neither)), 'Triage Low');
  assert.deepStrictEqual(
    chipColors(doneRow(doc, neither)),
    ['Label--secondary', 'Label--secondary'],
    'a state that is neither ending takes no color'
  );

  // A chip carrying a color no rule defines draws as though it carried none.
  for (const name of ['bghsa-tone-done', 'bghsa-tone-success', 'bghsa-fill']) {
    assert.ok(view.STYLE_TEXT.includes(`.${name} {`), `no rule defines .${name}`);
  }
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

test('the header tells a list still filling from one that will stay short', async () => {
  const members = [member({ ghsaId: ghsa('eeff'), state: 'closed', severity: 'high' })];
  const header = `#${view.ROOT_ID} .bghsa-done-header span.Label`;

  // A corpus assembled inside the walk that is filling it.
  const doc = await page(corpusOf(members, { complete: false, running: true }));
  assert.deepStrictEqual(textsOf(doc, header), ['Loading...']);

  // The pass ended and the walk never reached the last page, so what is missing
  // is not on its way.
  view.setState(doc, { corpus: corpusOf(members, { complete: false, running: false }) });
  view.draw(doc);
  assert.deepStrictEqual(textsOf(doc, header), ['Failed to load all advisories']);

  // A walk that reached the last page of both states says nothing.
  view.setState(doc, { corpus: corpusOf(members, { complete: true, running: false }) });
  view.draw(doc);
  assert.deepStrictEqual(textsOf(doc, header), []);
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
    fetch: async (url, init) => {
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
    fetch: async (url, init) => {
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
  pages[`${base}?state=published`] = listHtml({
    state: 'published',
    ids: [readable, unreadable],
    counts: { published: 2, closed: 0 },
  });
  pages[detailUrl(readable)] = detailHtml({
    ghsaId: readable,
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  // The closed list page and one advisory are the pages GitHub does not answer.
  delete pages[closedUrl];
  delete pages[detailUrl(unreadable)];
  await cache.clear();

  const doc = await page();
  const held = await view.collect(doc);
  assert.ok(held !== null, 'the collection ran');

  const banner = one(doc, `#${view.ROOT_ID} .bghsa-done-banner`);
  const lines = textsOf(banner, '.bghsa-done-failure');
  assert.strictEqual(lines.length, 2, `the failures named: ${lines.join(' | ')}`);
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
    lines.includes('Failed to load 1 advisory'),
    `the read that failed is counted: ${lines.join(' | ')}`
  );
  assert.deepStrictEqual(view.stateOf(doc).failures, lines, 'the view holds what it drew');
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
