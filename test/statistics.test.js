'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML, DOMParser } = require('linkedom');

const cache = require('../src/common/cache.js');
const schema = require('../src/common/schema.js');
const parseList = require('../src/common/parse-list.js');
const table = require('../src/list/table.js');
const csv = require('../src/done/csv.js');
const view = require('../src/done/view.js');
const statistics = require('../src/stats/statistics.js');

const { fakeStorage } = require('../test-support/storage.js');

// The queue and the crawl turn a fetched page into a document the way a content
// script does. Nothing in this file reaches the network: every response is a
// string a test wrote.
globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

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
    const body = pages[url];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  },
};

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
 * @param {string} html
 * @returns {Document} that markup inside the frame GitHub replaces on a soft
 *   navigation.
 */
function pageOf(html) {
  return /** @type {Document} */ (
    /** @type {unknown} */ (
      parseHTML(
        '<!doctype html><html><head></head><body><div id="repo-content-turbo-frame">' +
          html +
          '</div></body></html>'
      ).document
    )
  );
}

/**
 * One advisory as a list row names it.
 *
 * @typedef {object} Named
 * @property {string} ghsaId
 * @property {string | null} [severity] Null for a row GitHub painted no
 *   severity chip on, which is what a count with no value for a member reads.
 * @property {string} [openedAt]
 */

/**
 * One page of the advisory list, in the shape `parse-list` reads.
 *
 * @param {{
 *   ref: { owner: string, repo: string },
 *   state: string,
 *   rows: readonly Named[],
 *   counts?: Record<string, number>,
 * }} page
 * @returns {string}
 */
function listHtml(page) {
  const label = /** @type {string} */ (parseList.STATES[page.state]);
  const base = `/${page.ref.owner}/${page.ref.repo}/security/advisories`;
  const counts = page.counts ?? {};
  const tabs = Object.entries(parseList.STATES)
    .map(
      ([state, name]) =>
        `<li class="SegmentedControl-item"><a href="${base}?state=${state}"${
          state === page.state ? ' aria-current="true"' : ''
        }>${counts[state] ?? 0} ${name}</a></li>`
    )
    .join('');
  const rows = page.rows
    .map((row) => {
      const severity = row.severity === null ? null : (row.severity ?? 'High');
      return (
        '<div class="Box-row Box-row--drag-hide">' +
        `<a class="Link--primary" href="${base}/${row.ghsaId}">Title ${row.ghsaId}</a>` +
        `<span class="tooltipped" aria-label="${label} advisory"></span>` +
        (severity === null
          ? ''
          : `<span class="Label" title="Severity: ${severity}">${severity}</span>`) +
        '<span class="opened-by">opened <relative-time datetime="' +
        `${row.openedAt ?? '2026-03-02T00:00:00Z'}"></relative-time>` +
        ' by <a class="author" href="/prakleumas">prakleumas</a></span>' +
        '</div>'
      );
    })
    .join('');
  // GitHub carries the segmented control and the rows in one Box, which is what
  // the extension holds out of view as one act, and what it anchors its own
  // surface to on a repository with no advisory in the state being shown.
  return (
    '<div id="advisories"><div class="Box">' +
    `<segmented-control><ul>${tabs}</ul></segmented-control>${rows}</div></div>`
  );
}

/**
 * An advisory record in the shape the cache holds, carrying only what a
 * statistic reads.
 *
 * @param {{
 *   ref: { owner: string, repo: string },
 *   ghsaId: string,
 *   state: string,
 *   severity?: string,
 *   reportedAt?: string,
 *   timeline?: readonly { at: string, text: string }[],
 *   closureReason?: string,
 * }} fields
 * @returns {unknown}
 */
function stored(fields) {
  return {
    ref: { ...fields.ref, ghsaId: fields.ghsaId },
    ghsaId: fields.ghsaId,
    state: fields.state,
    severity: fields.severity ?? 'high',
    severityLabel: null,
    severityClass: null,
    reportedAt: fields.reportedAt ?? '2026-03-02T00:00:00Z',
    reporter: 'prakleumas',
    title: `Title ${fields.ghsaId}`,
    description: null,
    severityField: null,
    severityFieldPresent: false,
    cvssV3: null,
    cvssV3Present: false,
    cveId: null,
    cveSelection: null,
    descriptionOriginal: null,
    descriptionRevision: null,
    comments:
      fields.closureReason === undefined
        ? []
        : [
            {
              id: '91',
              elementId: 'advisory-comment-91',
              author: 'samuelkarp',
              role: 'Member',
              roles: ['Member'],
              at: '2026-04-06T00:00:00Z',
              trusted: true,
              text: '',
              stateComment: schema.readSnapshot(
                JSON.stringify({
                  betterGhsa: '1.0',
                  seq: 1,
                  by: 'samuelkarp',
                  at: '2026-04-06T00:00:00Z',
                  closure: { reason: fields.closureReason },
                })
              ),
            },
          ],
    timeline: (fields.timeline ?? []).map((event, index) => ({
      id: `event-${index}`,
      actor: 'samuelkarp',
      at: event.at,
      text: event.text,
    })),
    fork: null,
    collaborators: [],
  };
}

/**
 * @param {string} suffix
 * @returns {string}
 */
function ghsa(suffix) {
  return `GHSA-${suffix}-${suffix}-${suffix}`;
}

/**
 * A repository whose list pages this file answers for, its rendered list page,
 * and the crawls that have been run over it.
 *
 * The advisory reads are put in the cache rather than fetched, because a
 * statistic is over what a read holds and not over the markup it came from.
 * The list pages are fetched, because walking them is what the two crawls do
 * and what this view must not do again.
 *
 * @param {{
 *   owner: string,
 *   states: Record<string, readonly Named[]>,
 *   reads?: readonly {
 *     ghsaId: string,
 *     state: string,
 *     severity?: string,
 *     reportedAt?: string,
 *     timeline?: readonly { at: string, text: string }[],
 *     closureReason?: string,
 *   }[],
 *   crawl?: readonly ('open' | 'done')[],
 *   showing?: string,
 * }} setup
 * @returns {Promise<{ doc: Document, ref: { owner: string, repo: string }, base: string }>}
 */
async function repository(setup) {
  const ref = { owner: setup.owner, repo: 'Spoon-Knife' };
  const base = `/${ref.owner}/${ref.repo}/security/advisories`;
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [state, rows] of Object.entries(setup.states)) counts[state] = rows.length;
  for (const state of Object.keys(parseList.STATES)) {
    pages[`${base}?state=${state}`] = listHtml({
      ref,
      state,
      rows: setup.states[state] ?? [],
      counts,
    });
  }
  for (const read of setup.reads ?? []) {
    await cache.putAdvisory({ ...ref, ghsaId: read.ghsaId }, stored({ ref, ...read }), {
      storage: cache.storageOf(),
      at: clockAt,
    });
  }

  // The one queue this repository's requests go through, made here so neither
  // surface makes one that would reach the network.
  table.queueFor(ref, QUEUE_OPTIONS);
  const showing = setup.showing ?? 'triage';
  const doc = pageOf(
    listHtml({ ref, state: showing, rows: setup.states[showing] ?? [], counts })
  );
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');

  const href = `https://github.com${base}?state=${showing}`;
  for (const half of setup.crawl ?? []) {
    if (half === 'open') await table.refresh(doc, { ...QUEUE_OPTIONS, href });
    else await view.collect(doc, { ...QUEUE_OPTIONS, href });
  }
  return { doc, ref, base };
}

/**
 * Lets whatever the last act started run to the point of asking for something.
 * A crawl spends its first request after several turns of the event loop, so a
 * test that asserts nothing was asked for has to wait for the asking.
 *
 * @param {number} [turns]
 * @returns {Promise<void>}
 */
async function settle(turns = 50) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/**
 * @param {Document} doc
 * @returns {HTMLElement} the toggle this view puts on the bar.
 */
function statsToggle(doc) {
  return /** @type {HTMLElement} */ (
    /** @type {unknown} */ (one(doc, `#${table.ROOT_ID} .bghsa-stats-toggle`))
  );
}

/**
 * @param {Document} doc
 * @returns {string[]} the chips saying what the numbers are over.
 */
function over(doc) {
  return textsOf(doc, `#${statistics.ROOT_ID} .bghsa-stats-over span.Label`);
}

/**
 * @param {Document} doc
 * @param {string} selector
 * @returns {string[]} one list's lines, each as the cells it carries. The cells
 *   sit against each other, so the text of the line alone runs them together.
 */
function lines(doc, selector) {
  return Array.from(doc.querySelectorAll(`#${statistics.ROOT_ID} ${selector} li`)).map((line) => {
    const cells = Array.from(line.children).map((cell) =>
      (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
    );
    const held = cells.length === 0 ? [(line.textContent ?? '').trim()] : cells;
    return held.filter((cell) => cell !== '').join(' ');
  });
}

/**
 * @param {Document} doc
 * @param {string} key
 * @returns {string[]} one count's lines, each as its value, its number and its
 *   share.
 */
function countLines(doc, key) {
  return lines(doc, `[data-bghsa-count="${key}"]`);
}

/**
 * @param {Document} doc
 * @param {string} key
 * @returns {string[]} one timing's four lines.
 */
function timingLines(doc, key) {
  return lines(doc, `[data-bghsa-timing="${key}"]`);
}

test('the statistics open from their own toggle on the same bar', async () => {
  const { doc } = await repository({
    owner: 'stats-toggle',
    states: { triage: [{ ghsaId: ghsa('aaaa') }] },
  });

  const toggle = statsToggle(doc);
  assert.strictEqual(
    (toggle.textContent ?? '').trim(),
    statistics.SHOW_STATS,
    'the toggle offers the view'
  );
  assert.ok(
    toggle.previousElementSibling === one(doc, `#${table.ROOT_ID} .bghsa-done-toggle`),
    'the toggle sits beside the one that opens the done view'
  );

  toggle.click();
  await statistics.load(doc);
  assert.strictEqual(table.viewMode(doc), statistics.MODE, 'the page is on the statistics');
  assert.strictEqual(
    (statsToggle(doc).textContent ?? '').trim(),
    statistics.SHOW_OPEN,
    'and the toggle offers the way back'
  );
  assert.ok(
    one(doc, `#${table.ROOT_ID} .bghsa-list-box`).classList.contains(table.HIDDEN_CLASS),
    'the table is out of view'
  );
  assert.ok(
    one(doc, `#${view.ROOT_ID}`).classList.contains(table.HIDDEN_CLASS),
    'and so is the done view'
  );
});

test('the statistics are over the whole corpus, open and done', async () => {
  const open = [ghsa('bbbb'), ghsa('cccc')];
  const drafting = ghsa('dddd');
  const publishedId = ghsa('eeee');
  const closedId = ghsa('ffff');
  const { doc } = await repository({
    owner: 'stats-whole',
    states: {
      triage: [{ ghsaId: open[0] ?? '' }, { ghsaId: open[1] ?? '', severity: 'Low' }],
      draft: [{ ghsaId: drafting }],
      published: [{ ghsaId: publishedId }],
      closed: [{ ghsaId: closedId }],
    },
    reads: [
      {
        ghsaId: drafting,
        state: 'Draft',
        reportedAt: '2026-03-02T00:00:00Z',
        // An advisory still being worked contributes a timing. A statistic over
        // the done half alone would not count it.
        timeline: [{ at: '2026-03-04T00:00:00Z', text: 'samuelkarp accepted this report' }],
      },
      { ghsaId: publishedId, state: 'Published', reportedAt: '2026-04-05T00:00:00Z' },
      { ghsaId: closedId, state: 'Closed', reportedAt: '2026-04-05T00:00:00Z' },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(
    over(doc),
    ['5 total advisories', '3 open', '2 done', '2 unread'],
    'the corpus is both halves, and both are walked to their last page'
  );

  // Four states, which is what says the count is not over the done half alone
  // and not over the open half alone.
  assert.deepStrictEqual(countLines(doc, 'state'), [
    'Triage 2 40%',
    'Closed 1 20%',
    'Draft 1 20%',
    'Published 1 20%',
  ]);
  assert.deepStrictEqual(
    countLines(doc, 'severity'),
    ['High 4 80%', 'Low 1 20%'],
    'the severity comes off the list row where no read backs it'
  );
  assert.deepStrictEqual(
    countLines(doc, 'month'),
    ['2026-03 3 60%', '2026-04 2 40%'],
    'and so does the month'
  );
  // The list is how a finished advisory finished. Three of these five are still
  // being worked, so they are in none of it; the published one ended by being
  // published, and the closed one ended with nobody having given a reason,
  // which is an ending of its own and holds a share like any other.
  assert.deepStrictEqual(countLines(doc, 'reason'), ['Published 1 50%', 'None 1 50%']);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="reason"] .bghsa-stats-meta`),
    '2 of 2',
    'the endings are counted over the advisories that ended'
  );

  assert.deepStrictEqual(
    timingLines(doc, 'accept'),
    ['Min 2d 0h', 'Median 2d 0h', 'Mean 2d 0h', 'Max 2d 0h', 'Never accepted 4'],
    'the open half contributes its timings'
  );
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="accept"] .bghsa-stats-meta`),
    '1 of 5'
  );
});

test('the endings list counts a close with no reason and omits one nobody read', async () => {
  // Five advisories, one of each thing an ending can be. REQUIREMENTS.md
  // section 10 omits a metric where the event it needs is not observable, so
  // the closed advisory no read backs is counted nowhere: nothing has been read
  // to say what reason it carries.
  const open = ghsa('kaaa');
  const publishedId = ghsa('kbbb');
  const named = ghsa('kccc');
  const bare = ghsa('kddd');
  const unread = ghsa('keee');
  const { doc } = await repository({
    owner: 'stats-endings',
    states: {
      // This one carries no severity chip, so the severity count holds no value
      // for it and draws the row a count holds for the members carrying none.
      triage: [{ ghsaId: open, severity: null }],
      published: [{ ghsaId: publishedId }],
      closed: [{ ghsaId: named }, { ghsaId: bare }, { ghsaId: unread }],
    },
    reads: [
      { ghsaId: publishedId, state: 'Published' },
      { ghsaId: named, state: 'Closed', closureReason: 'duplicate' },
      { ghsaId: bare, state: 'Closed' },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(countLines(doc, 'reason'), [
    'Duplicate 1 33%',
    'Published 1 33%',
    'None 1 33%',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="reason"] .bghsa-stats-meta`),
    '3 of 3',
    'the advisory nobody read is inside the endings'
  );

  // The other counts are unchanged by that. A severity nobody set is an absence
  // to them: it stands outside the shares, which are over the four that carried
  // one, and it is marked as holding none.
  assert.deepStrictEqual(countLines(doc, 'severity'), ['High 4 100%', 'None 1 —']);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="severity"] .bghsa-stats-meta`),
    '4 of 5'
  );
});

test('a half nothing has crawled says what its numbers are over', async () => {
  const showing = [ghsa('gggg'), ghsa('hhhh')];
  const { doc } = await repository({
    owner: 'stats-half',
    states: {
      triage: showing.map((ghsaId) => ({ ghsaId })),
      published: [{ ghsaId: ghsa('iiii') }],
      closed: [{ ghsaId: ghsa('jjjj') }],
    },
    crawl: ['done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  // The open half is the page the maintainer is looking at and nothing more,
  // because no walk of it has run. It says so beside the numbers.
  assert.deepStrictEqual(over(doc), [
    '4 total advisories',
    '2 open',
    'Open not crawled',
    '2 done',
    '4 unread',
  ]);
  assert.deepStrictEqual(countLines(doc, 'state'), [
    'Triage 2 50%',
    'Closed 1 25%',
    'Published 1 25%',
  ]);

  // The other way round: the open half walked and the done half not.
  const other = await repository({
    owner: 'stats-half-other',
    states: {
      triage: showing.map((ghsaId) => ({ ghsaId })),
      draft: [{ ghsaId: ghsa('kkkk') }],
      published: [{ ghsaId: ghsa('llll') }],
    },
    crawl: ['open'],
  });
  statsToggle(other.doc).click();
  await statistics.load(other.doc);
  assert.deepStrictEqual(over(other.doc), [
    '3 total advisories',
    '3 open',
    '0 done',
    'Done not crawled',
    '3 unread',
    '4 on GitHub',
  ]);
  assert.deepStrictEqual(countLines(other.doc, 'state'), ['Triage 2 67%', 'Draft 1 33%']);
});

test('a repository nothing has read says so and offers no export', async () => {
  const { doc } = await repository({ owner: 'stats-empty', states: {} });
  statsToggle(doc).click();
  await statistics.load(doc);

  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} .bghsa-stats-empty`),
    statistics.EMPTY_TEXT
  );
  assert.ok(
    one(doc, `#${statistics.ROOT_ID} button.bghsa-stats-export`).hasAttribute('disabled'),
    'there is nothing to export'
  );
  assert.strictEqual(statistics.exportCsv(doc), null, 'and asking for one writes nothing');
  assert.strictEqual(
    doc.querySelector(`#${statistics.ROOT_ID} [data-bghsa-count]`),
    null,
    'and no count is drawn over nothing'
  );
});

test('the statistics view asks GitHub for nothing of its own', async () => {
  const { doc, base } = await repository({
    owner: 'stats-quiet',
    states: {
      triage: [{ ghsaId: ghsa('mmmm') }],
      published: [{ ghsaId: ghsa('nnnn') }],
      closed: [{ ghsaId: ghsa('oooo') }],
    },
    crawl: ['open', 'done'],
  });

  const before = asked.length;
  statsToggle(doc).click();
  await statistics.load(doc);
  // Opening it again, and drawing it again, are both free.
  statsToggle(doc).click();
  statsToggle(doc).click();
  await statistics.load(doc);
  statistics.draw(doc);
  await settle();

  // Scoped to this repository: another test's crawl retrying a page this file
  // never wrote is not this view asking for something.
  assert.deepStrictEqual(
    asked.slice(before).filter((url) => url.startsWith(base)),
    [],
    'the view spent a request of its own'
  );
  assert.deepStrictEqual(
    over(doc),
    ['3 total advisories', '1 open', '2 done', '3 unread'],
    'and it still drew the whole corpus, so the count above is not over nothing'
  );
});

test('the export is the whole corpus, written here in the page', async () => {
  const openId = ghsa('pppp');
  const doneId = ghsa('qqqq');
  const { doc, ref } = await repository({
    owner: 'stats-export',
    states: { triage: [{ ghsaId: openId }], closed: [{ ghsaId: doneId }] },
    reads: [{ ghsaId: doneId, state: 'Closed', reportedAt: '2026-04-05T00:00:00Z' }],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);
  assert.ok(
    !one(doc, `#${statistics.ROOT_ID} button.bghsa-stats-export`).hasAttribute('disabled'),
    'there is something to export'
  );

  /** @type {unknown[]} */
  const parts = [];
  class FakeBlob {
    /** @param {unknown[]} pieces */
    constructor(pieces) {
      parts.push(...pieces);
    }
  }
  const url = statistics.exportCsv(doc, {
    Blob: /** @type {typeof globalThis.Blob} */ (/** @type {unknown} */ (FakeBlob)),
    createObjectURL: () => 'blob:https://github.com/statistics',
    revokeObjectURL: () => {},
  });

  assert.strictEqual(url, 'blob:https://github.com/statistics');
  const lines = /** @type {string} */ (parts[0]).split('\r\n');
  assert.strictEqual(lines[0], csv.COLUMNS.join(','));
  assert.strictEqual(
    lines[1],
    `${openId},Title ${openId},triage,high,,2026-03-02T00:00:00Z,2026-03,,,,,no,`,
    'the open half is in the file'
  );
  assert.ok(
    (lines[2] ?? '').startsWith(
      `${doneId},Title ${doneId},closed,high,,2026-04-05T00:00:00Z,2026-04`
    ),
    `the done half is in the file: ${lines[2]}`
  );
  assert.strictEqual(lines[3], '', 'and nothing else is');
  assert.strictEqual(
    csv.filenameFor(ref, Date.parse('2026-08-27T12:00:00Z')),
    'stats-export-Spoon-Knife-advisories-2026-08-27.csv'
  );
});

test('the statistics say a crawl is filling the corpus they are over', async () => {
  const { doc } = await repository({
    owner: 'stats-reading',
    states: { triage: [{ ghsaId: ghsa('rrrr') }], closed: [{ ghsaId: ghsa('ssss') }] },
    crawl: ['done'],
  });
  statsToggle(doc).click();
  await statistics.load(doc);
  assert.ok(!over(doc).includes(statistics.READING_TEXT), 'nothing is running');

  // The done view's collection is what fills the done half, and the numbers
  // move under the reader while it runs.
  view.setState(doc, { reading: true });
  statistics.draw(doc);
  assert.ok(over(doc).includes(statistics.READING_TEXT), 'and the numbers do not say so');
  view.setState(doc, { reading: false });
});

test('the numbers are not drawn under the repository the maintainer moved to', async () => {
  const { doc, ref } = await repository({
    owner: 'stats-moved',
    states: { triage: [{ ghsaId: ghsa('tttt') }], closed: [{ ghsaId: ghsa('uuuu') }] },
    crawl: ['open', 'done'],
  });
  statsToggle(doc).click();
  await statistics.load(doc);
  assert.deepStrictEqual(over(doc), ['2 total advisories', '1 open', '1 done', '2 unread']);
  assert.strictEqual(statistics.current(doc).ref?.owner, ref.owner);

  // GitHub replaces the turbo frame on a soft navigation and keeps the
  // document. The page now names another repository.
  const other = { owner: 'stats-moved-to', repo: 'Fork-Knife' };
  one(doc, '#repo-content-turbo-frame').innerHTML = listHtml({
    ref: other,
    state: 'triage',
    rows: [{ ghsaId: ghsa('vvvv') }],
  });
  table.queueFor(other, QUEUE_OPTIONS);
  const root = await table.render(doc);
  if (root === null) throw new Error('the page offered no anchor');

  assert.strictEqual(statistics.current(doc).ref, null, 'the view is still holding them');
  assert.strictEqual(
    doc.querySelector(`#${statistics.ROOT_ID} [data-bghsa-count]`),
    null,
    "the previous repository's counts are drawn under the new page"
  );
  assert.strictEqual(statistics.exportCsv(doc), null, 'and a file of them can still be asked for');
});

test('each timing says how many it could not measure and why', async () => {
  const silent = ghsa('ssss');
  const acceptedOne = ghsa('tttt');
  const acceptedTwo = ghsa('uuuu');
  const publishedId = ghsa('vvvv');
  const closedOne = ghsa('wwww');
  const closedTwo = ghsa('xxxx');
  const reported = '2026-03-02T00:00:00Z';
  const { doc } = await repository({
    owner: 'stats-omitted',
    states: {
      triage: [{ ghsaId: silent }],
      draft: [{ ghsaId: acceptedOne }, { ghsaId: acceptedTwo }],
      published: [{ ghsaId: publishedId }],
      closed: [{ ghsaId: closedOne }, { ghsaId: closedTwo }],
    },
    reads: [
      {
        ghsaId: acceptedOne,
        state: 'Draft',
        reportedAt: reported,
        timeline: [{ at: '2026-03-03T00:00:00Z', text: 'samuelkarp accepted this report' }],
      },
      {
        ghsaId: acceptedTwo,
        state: 'Draft',
        reportedAt: reported,
        timeline: [{ at: '2026-03-05T00:00:00Z', text: 'samuelkarp accepted this report' }],
      },
      {
        ghsaId: publishedId,
        state: 'Published',
        reportedAt: reported,
        timeline: [
          { at: '2026-03-04T00:00:00Z', text: 'samuelkarp accepted this report' },
          { at: '2026-03-12T00:00:00Z', text: 'samuelkarp published this' },
        ],
      },
      {
        ghsaId: closedOne,
        state: 'Closed',
        reportedAt: reported,
        timeline: [{ at: '2026-03-06T00:00:00Z', text: 'samuelkarp closed this' }],
      },
      {
        ghsaId: closedTwo,
        state: 'Closed',
        reportedAt: reported,
        timeline: [{ at: '2026-03-10T00:00:00Z', text: 'samuelkarp closed this' }],
      },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  // Six advisories: one nothing has read, three accepted, one of those three
  // published, and two closed. No comment is on any of them, so nobody
  // answered a reporter. Each timing's last row names the event it needed and
  // how many advisories never had it, and the four numbers differ, so a row
  // taking another timing's count would read wrong here.
  assert.deepStrictEqual(timingLines(doc, 'firstResponse'), [
    'Min —',
    'Median —',
    'Mean —',
    'Max —',
    'No response 6',
  ]);
  assert.deepStrictEqual(timingLines(doc, 'accept'), [
    'Min 1d 0h',
    'Median 2d 0h',
    'Mean 2d 0h',
    'Max 3d 0h',
    'Never accepted 3',
  ]);
  assert.deepStrictEqual(timingLines(doc, 'close'), [
    'Min 4d 0h',
    'Median 6d 0h',
    'Mean 6d 0h',
    'Max 8d 0h',
    'Never closed 4',
  ]);
  assert.deepStrictEqual(timingLines(doc, 'publish'), [
    'Min 10d 0h',
    'Median 10d 0h',
    'Mean 10d 0h',
    'Max 10d 0h',
    'Never published 5',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="close"] .bghsa-stats-meta`),
    '2 of 6',
    'and the header says what it measured, without the omission it now carries'
  );
});

test('a timing that measured every advisory carries no omission row', async () => {
  const first = ghsa('yyyy');
  const second = ghsa('zzzz');
  const reported = '2026-03-02T00:00:00Z';
  const { doc } = await repository({
    owner: 'stats-omitted-none',
    states: { draft: [{ ghsaId: first }, { ghsaId: second }] },
    showing: 'draft',
    reads: [
      {
        ghsaId: first,
        state: 'Draft',
        reportedAt: reported,
        timeline: [{ at: '2026-03-03T00:00:00Z', text: 'samuelkarp accepted this report' }],
      },
      {
        ghsaId: second,
        state: 'Draft',
        reportedAt: reported,
        timeline: [{ at: '2026-03-03T00:00:00Z', text: 'samuelkarp accepted this report' }],
      },
    ],
    crawl: ['open'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(timingLines(doc, 'accept'), [
    'Min 1d 0h',
    'Median 1d 0h',
    'Mean 1d 0h',
    'Max 1d 0h',
  ]);
  assert.strictEqual(
    doc.querySelector(`#${statistics.ROOT_ID} [data-bghsa-timing="accept"] .bghsa-stats-omitted`),
    null,
    'nothing was left out, so there is nothing to say'
  );
  assert.deepStrictEqual(
    timingLines(doc, 'publish'),
    ['Min —', 'Median —', 'Mean —', 'Max —', 'Never published 2'],
    'and a timing that measured nothing still says why'
  );
});

