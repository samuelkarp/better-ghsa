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

globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

let clockAt = Date.parse('2026-08-27T12:00:00Z');
cache.setClock(() => clockAt);
cache.setStorage(fakeStorage());

/** @type {Record<string, string>} */
const pages = {};

/** @type {string[]} */
const asked = [];

/**
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
 * @returns {string[]} The matched texts with whitespace collapsed.
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
 * Describe the values available from a list row.
 *
 * @typedef {object} Named
 * @property {string} ghsaId
 * @property {string | null} [severity] Null when the row omits severity.
 * @property {string} [openedAt]
 */

/**
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
  // GitHub's Box contains both the tabs and rows. It exists even for an empty list.
  return (
    '<div id="advisories"><div class="Box">' +
    `<segmented-control><ul>${tabs}</ul></segmented-control>${rows}</div></div>`
  );
}

/**
 * @param {{
 *   ref: { owner: string, repo: string },
 *   ghsaId: string,
 *   state: string,
 *   severity?: string,
 *   reportedAt?: string,
 *   timeline?: readonly { at: string, text: string }[],
 *   closureReason?: string,
 *   confirmedScoring?: string,
 * }} fields
 * @returns {unknown} The record, with a snapshot holding a closure reason and a
 *   scoring confirmation when either is supplied. A confirmed scoring is the
 *   severity selection with an empty vector field.
 */
function stored(fields) {
  const severity = fields.severity ?? 'high';
  /** @type {Record<string, unknown> | null} */
  let snapshot = null;
  if (fields.closureReason !== undefined || fields.confirmedScoring !== undefined) {
    snapshot = { betterGhsa: '1.0', seq: 1, by: 'samuelkarp', at: '2026-04-06T00:00:00Z' };
    if (fields.closureReason !== undefined) snapshot.closure = { reason: fields.closureReason };
    if (fields.confirmedScoring !== undefined) {
      snapshot.confirmed = {
        scoring: { by: 'samuelkarp', at: '2026-04-06T00:00:00Z', fp: fields.confirmedScoring },
      };
    }
  }
  return {
    ref: { ...fields.ref, ghsaId: fields.ghsaId },
    ghsaId: fields.ghsaId,
    state: fields.state,
    severity,
    severityLabel: null,
    severityClass: null,
    reportedAt: fields.reportedAt ?? '2026-03-02T00:00:00Z',
    reporter: 'prakleumas',
    title: `Title ${fields.ghsaId}`,
    description: null,
    severityField: fields.confirmedScoring === undefined ? null : severity,
    severityFieldPresent: fields.confirmedScoring !== undefined,
    cvssV3: fields.confirmedScoring === undefined ? null : '',
    cvssV3Present: fields.confirmedScoring !== undefined,
    cveId: null,
    cveSelection: null,
    descriptionOriginal: null,
    descriptionRevision: null,
    comments:
      snapshot === null
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
              stateComment: schema.readSnapshot(JSON.stringify(snapshot)),
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
 * Populate cached advisory records and serve list pages through the queue.
 * Run the requested crawls before returning the rendered page.
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
 *     confirmedScoring?: string,
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
 * Allow the crawl to reach its first request before checking request counts.
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
 * @returns {string[]} The corpus status chips.
 */
function over(doc) {
  return textsOf(doc, `#${statistics.ROOT_ID} .bghsa-stats-over span.Label`);
}

/**
 * @param {Document} doc
 * @param {string} selector
 * @returns {string[]} Each row's nonempty cell texts, separated by spaces.
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
    ['5 total advisories', '3 open', '2 completed', '2 not loaded yet'],
    'the corpus is both halves, and both are walked to their last page'
  );

  assert.deepStrictEqual(
    countLines(doc, 'open'),
    ['Triage 2 67%', 'Draft 1 33%'],
    'the open advisories are counted by state, and the ended ones are left to the outcome'
  );
  assert.deepStrictEqual(
    textsOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="open"] .Box-header > *`),
    ['Open', '3 of 3']
  );
  assert.deepStrictEqual(
    Array.from(doc.querySelectorAll(`#${statistics.ROOT_ID} [data-bghsa-count]`)).map((box) =>
      box.getAttribute('data-bghsa-count')
    ),
    ['outcome', 'reason', 'open', 'severity'],
    'the outcome comes first, ahead of the closure reason'
  );
  assert.deepStrictEqual(countLines(doc, 'outcome'), ['Closed 1 50%', 'Published 1 50%']);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="outcome"] .bghsa-stats-meta`),
    '2 of 2',
    'the outcomes are counted over the advisories that ended'
  );
  assert.deepStrictEqual(countLines(doc, 'reason'), ['None 1 100%']);

  assert.deepStrictEqual(
    timingLines(doc, 'accept'),
    ['Min 2d 0h', 'Median 2d 0h', 'Mean 2d 0h', 'Max 2d 0h'],
    'the open half contributes its timings'
  );
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="accept"] .bghsa-stats-meta`),
    '3 of 5'
  );
});

/**
 * @param {Document} doc
 * @returns {string[][]} Each row of the reports-by-month table as its cell
 *   texts, header row first.
 */
function monthCells(doc) {
  return Array.from(
    doc.querySelectorAll(`#${statistics.ROOT_ID} [data-bghsa-months] tr`)
  ).map((row) => Array.from(row.children).map((cell) => (cell.textContent ?? '').trim()));
}

test('reports are counted by month in a table of years', async () => {
  const crossing = ghsa('maaa');
  const current = ghsa('mbbb');
  const early = ghsa('mccc');
  const earlyUnread = ghsa('mddd');
  const undated = ghsa('meee');
  const { doc } = await repository({
    owner: 'stats-months',
    states: {
      triage: [{ ghsaId: crossing }, { ghsaId: current, openedAt: '2026-08-01T00:00:00Z' }],
      published: [{ ghsaId: early }],
      closed: [
        { ghsaId: earlyUnread, openedAt: '2024-03-20T00:00:00Z' },
        { ghsaId: undated, openedAt: '' },
      ],
    },
    reads: [
      // 04:30 on the first of January in UTC.
      { ghsaId: crossing, state: 'Triage', reportedAt: '2025-12-31T23:30:00-05:00' },
      { ghsaId: early, state: 'Published', reportedAt: '2024-03-10T00:00:00Z' },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(
    textsOf(doc, `#${statistics.ROOT_ID} [data-bghsa-months] .Box-header > *`),
    ['Reports by month', '4 of 5'],
    'the advisory without a report time is outside the table and inside the total'
  );
  // The clock reads August 2026, so September to December are blank.
  assert.deepStrictEqual(monthCells(doc), [
    [
      ...['Year', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
      ...['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Total'],
    ],
    ['2024', '0', '0', '2', '0', '0', '0', '0', '0', '0', '0', '0', '0', '2'],
    ['2025', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
    ['2026', '1', '0', '0', '0', '0', '0', '0', '1', '', '', '', '', '2'],
  ]);
  assert.deepStrictEqual(
    Array.from(doc.querySelectorAll(`#${statistics.ROOT_ID} [data-bghsa-months] th`)).map(
      (cell) => cell.getAttribute('scope')
    ),
    [...Array(14).fill('col'), 'row', 'row', 'row'],
    'the headers name their columns and the years name their rows'
  );

  const months = one(doc, `#${statistics.ROOT_ID} [data-bghsa-months]`);
  assert.ok(months.parentElement === one(doc, `#${statistics.ROOT_ID}`), 'on its own row');
  assert.ok(
    months.previousElementSibling === one(doc, `#${statistics.ROOT_ID} .bghsa-stats-counts`) &&
      months.nextElementSibling === one(doc, `#${statistics.ROOT_ID} .bghsa-stats-timings`),
    'between the counts and the timings'
  );
});

test('the table of years runs to the instant its summary was taken at', async () => {
  const reported = ghsa('oaaa');
  const { doc } = await repository({
    owner: 'stats-months-at',
    states: { triage: [{ ghsaId: reported }] },
    reads: [{ ghsaId: reported, state: 'Triage', reportedAt: '2026-03-02T00:00:00Z' }],
    crawl: ['open'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);
  const held = clockAt;
  // Redrawing without a load keeps the summary taken in 2026.
  clockAt = Date.parse('2027-02-15T00:00:00Z');
  try {
    statistics.draw(doc);
  } finally {
    clockAt = held;
  }

  assert.deepStrictEqual(
    monthCells(doc)
      .slice(1)
      .map((row) => row[0]),
    ['2026'],
    'a later clock added a year the summary never reached'
  );
});

test('reports without a time leave the table empty', async () => {
  const { doc } = await repository({
    owner: 'stats-undated',
    states: { triage: [{ ghsaId: ghsa('naaa'), openedAt: '' }] },
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(
    textsOf(doc, `#${statistics.ROOT_ID} [data-bghsa-months] .Box-header > *`),
    ['Reports by month', '0 of 1']
  );
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-months] .Box-body`),
    'Nothing counted'
  );
  assert.strictEqual(doc.querySelector(`#${statistics.ROOT_ID} [data-bghsa-months] table`), null);
});

test('closure reasons count a close with no reason and list the unread apart', async () => {
  const open = ghsa('kaaa');
  const publishedId = ghsa('kbbb');
  const named = ghsa('kccc');
  const bare = ghsa('kddd');
  const unread = ghsa('keee');
  const { doc } = await repository({
    owner: 'stats-endings',
    states: {
      triage: [{ ghsaId: open, severity: null }],
      published: [{ ghsaId: publishedId }],
      closed: [{ ghsaId: named }, { ghsaId: bare }, { ghsaId: unread }],
    },
    reads: [
      { ghsaId: named, state: 'Closed', closureReason: 'duplicate' },
      { ghsaId: bare, state: 'Closed' },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(
    countLines(doc, 'outcome'),
    ['Closed 3 75%', 'Published 1 25%'],
    'the outcomes need no read'
  );
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="outcome"] .bghsa-stats-meta`),
    '4 of 4'
  );
  assert.deepStrictEqual(countLines(doc, 'reason'), [
    'Duplicate 1 50%',
    'None 1 50%',
    'Not loaded yet 1 —',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="reason"] .bghsa-stats-meta`),
    '2 of 3',
    'the closed advisory nobody read is outside the percentages and inside the total'
  );
});

test('severities run by level over publications and confirmed drafts', async () => {
  const confirmed = ghsa('naaa');
  const unread = ghsa('nccc');
  /** @type {Named[]} */
  const published = [
    ...['nd01', 'nd02', 'nd03'].map((id) => ({ ghsaId: ghsa(id), severity: 'Low' })),
    ...['nd04', 'nd05'].map((id) => ({ ghsaId: ghsa(id), severity: 'Moderate' })),
    { ghsaId: ghsa('nd06'), severity: 'Critical' },
    // A level this reader does not rank, most frequent of all.
    ...['nd07', 'nd08', 'nd09', 'nd10'].map((id) => ({ ghsaId: ghsa(id), severity: 'Extreme' })),
    { ghsaId: ghsa('nd11'), severity: null },
  ];
  const { doc } = await repository({
    owner: 'stats-severity',
    states: {
      draft: [
        { ghsaId: confirmed, severity: 'High' },
        { ghsaId: unread, severity: 'Critical' },
      ],
      published,
    },
    reads: [
      {
        ghsaId: confirmed,
        state: 'Draft',
        severity: 'high',
        confirmedScoring: await schema.scoringFingerprint('high', ''),
      },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(countLines(doc, 'severity'), [
    'Critical 1 9%',
    'High 1 9%',
    'Moderate 2 18%',
    'Low 3 27%',
    'Extreme 4 36%',
    'None 1 —',
    'Not loaded yet 1 —',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="severity"] .bghsa-stats-meta`),
    '11 of 13',
    'the unset and unread severities are inside the total and outside the percentages'
  );
});

test('the closure reason None opens the completed list on those advisories', async () => {
  const named = ghsa('maaa');
  const bare = ghsa('mbbb');
  const unread = ghsa('mccc');
  const publishedId = ghsa('mddd');
  const { doc } = await repository({
    owner: 'stats-todo',
    states: {
      published: [{ ghsaId: publishedId }],
      closed: [{ ghsaId: named }, { ghsaId: bare }, { ghsaId: unread, severity: null }],
    },
    reads: [
      { ghsaId: named, state: 'Closed', closureReason: 'duplicate' },
      { ghsaId: bare, state: 'Closed' },
    ],
    // The statistics count the closed rows on the page; the completed view has
    // collected nothing.
    showing: 'closed',
  });

  statsToggle(doc).click();
  await statistics.load(doc);
  const rows = () =>
    Array.from(doc.querySelectorAll(`#${view.ROOT_ID} li.bghsa-done-row`))
      .map((row) => row.getAttribute('data-bghsa-ghsa'))
      .sort();
  assert.deepStrictEqual(rows(), [], 'the completed view has collected nothing');
  const opens = doc.querySelectorAll(`#${statistics.ROOT_ID} button.btn-link`);
  assert.strictEqual(opens.length, 1, 'only the closure reason None is a link');
  const open = /** @type {HTMLElement} */ (
    /** @type {unknown} */ (
      one(doc, `#${statistics.ROOT_ID} [data-bghsa-count="reason"] .bghsa-stats-missing button`)
    )
  );
  assert.strictEqual((open.textContent ?? '').trim(), 'None');

  open.click();
  await settle();

  assert.strictEqual(table.viewMode(doc), view.MODE, 'the page is on the completed view');
  assert.ok(one(doc, `#${statistics.ROOT_ID}`).classList.contains(table.HIDDEN_CLASS));
  const controls = one(doc, `#${table.ROOT_ID} .bghsa-done-controls`);
  assert.ok(!controls.classList.contains(table.HIDDEN_CLASS), 'its filters are in view');
  assert.deepStrictEqual(
    textsOf(controls, 'summary'),
    ['State: Closed', 'Closure reason: None', 'Severity'],
    'the menus hold the selection the link made'
  );
  assert.deepStrictEqual(
    rows(),
    [bare, unread].sort(),
    'the list shows the closed advisories a reason has still to be set on'
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

  assert.deepStrictEqual(over(doc), [
    '4 total advisories',
    '2 open',
    'Open list not loaded',
    '2 completed',
    '4 not loaded yet',
  ]);
  assert.deepStrictEqual(countLines(doc, 'open'), ['Triage 2 100%']);
  assert.deepStrictEqual(
    countLines(doc, 'reason'),
    ['Not loaded yet 1 —'],
    'a closure nobody read leaves only the unread row'
  );
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-count="reason"] .bghsa-stats-meta`),
    '0 of 1'
  );

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
    '0 completed',
    'Completed list not loaded',
    '3 not loaded yet',
    '4 on GitHub',
  ]);
  assert.deepStrictEqual(countLines(other.doc, 'open'), ['Triage 2 67%', 'Draft 1 33%']);
});

test('a half whose crawl stopped short says its list is partly loaded', async () => {
  const { doc, base } = await repository({
    owner: 'stats-partly',
    states: { published: [{ ghsaId: ghsa('plaa') }], closed: [{ ghsaId: ghsa('plbb') }] },
  });
  // The closed list fails, so the walk of the completed half stops short.
  delete pages[`${base}?state=closed`];
  await view.collect(doc, { ...QUEUE_OPTIONS, href: `https://github.com${base}?state=triage` });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.ok(
    over(doc).includes('Completed list partly loaded'),
    `the chips say nothing of the stopped walk: ${over(doc).join(', ')}`
  );
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
  assert.strictEqual(await statistics.exportCsv(doc), null, 'and asking for one writes nothing');
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
  statsToggle(doc).click();
  statsToggle(doc).click();
  await statistics.load(doc);
  statistics.draw(doc);
  await settle();

  // Other repositories may retry pending crawls. Count this repository's requests only.
  assert.deepStrictEqual(
    asked.slice(before).filter((url) => url.startsWith(base)),
    [],
    'the view spent a request of its own'
  );
  assert.deepStrictEqual(
    over(doc),
    ['3 total advisories', '1 open', '2 completed', '3 not loaded yet'],
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
  const url = await statistics.exportCsv(doc, {
    Blob: /** @type {typeof globalThis.Blob} */ (/** @type {unknown} */ (FakeBlob)),
    createObjectURL: () => 'blob:https://github.com/statistics',
    revokeObjectURL: () => {},
  });

  assert.strictEqual(url, 'blob:https://github.com/statistics');
  const lines = /** @type {string} */ (parts[0]).split('\r\n');
  assert.strictEqual(lines[0], csv.COLUMNS.join(','));
  assert.strictEqual(
    lines[1],
    `${openId},Title ${openId},triage,high,,,2026-03-02T00:00:00Z,2026-03,,,,,no,`,
    'the open half is in the file'
  );
  assert.ok(
    (lines[2] ?? '').startsWith(
      `${doneId},Title ${doneId},closed,high,no,,2026-04-05T00:00:00Z,2026-04`
    ),
    `the done half is in the file: ${lines[2]}`
  );
  assert.strictEqual(lines[3], '', 'and nothing else is');
  assert.strictEqual(
    csv.filenameFor(ref, Date.parse('2026-08-27T12:00:00Z')),
    'stats-export-Spoon-Knife-advisories-2026-08-27.csv'
  );
});

test('pressing the export writes the file', async () => {
  const { doc } = await repository({
    owner: 'stats-press',
    states: { triage: [{ ghsaId: ghsa('rrrr') }] },
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  /** @type {unknown[]} */
  const parts = [];
  class FakeBlob {
    /** @param {unknown[]} pieces */
    constructor(pieces) {
      parts.push(...pieces);
    }
  }
  const heldBlob = globalThis.Blob;
  const heldMake = globalThis.URL.createObjectURL;
  const heldDrop = globalThis.URL.revokeObjectURL;
  /** @type {string[]} */
  const dropped = [];
  globalThis.Blob = /** @type {typeof globalThis.Blob} */ (/** @type {unknown} */ (FakeBlob));
  globalThis.URL.createObjectURL = () => 'blob:https://github.com/pressed';
  globalThis.URL.revokeObjectURL = (url) => dropped.push(url);
  try {
    const button = /** @type {HTMLElement} */ (
      /** @type {unknown} */ (one(doc, `#${statistics.ROOT_ID} button.bghsa-stats-export`))
    );
    button.click();
    await settle();
    assert.strictEqual(parts.length, 1, 'the press wrote no file');
    const lines = /** @type {string} */ (parts[0]).split('\r\n');
    assert.strictEqual(lines[0], csv.COLUMNS.join(','));
    assert.ok((lines[1] ?? '').startsWith(ghsa('rrrr')), `the file holds: ${lines[1]}`);
  } finally {
    globalThis.Blob = heldBlob;
    globalThis.URL.createObjectURL = heldMake;
    globalThis.URL.revokeObjectURL = heldDrop;
  }
});

test('the statistics say a crawl is filling the corpus they are over', async () => {
  const { doc } = await repository({
    owner: 'stats-reading',
    states: { triage: [{ ghsaId: ghsa('rrrr') }], closed: [{ ghsaId: ghsa('ssss') }] },
    crawl: ['done'],
  });
  statsToggle(doc).click();
  await statistics.load(doc);
  assert.ok(!over(doc).includes('Loading...'), 'nothing is running');

  view.setState(doc, { reading: true });
  statistics.draw(doc);
  assert.ok(over(doc).includes('Loading...'), 'and the numbers do not say so');
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
  assert.deepStrictEqual(over(doc), ['2 total advisories', '1 open', '1 completed', '2 not loaded yet']);
  assert.strictEqual(statistics.current(doc).ref?.owner, ref.owner);

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
  assert.strictEqual(
    await statistics.exportCsv(doc),
    null,
    'and a file of them can still be asked for'
  );
});

test('the first response shows no wait when the advisory without one is unread', async () => {
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

  // Each action is a response: 1, 3, 2, 4, and 8 days after the report.
  assert.deepStrictEqual(
    timingLines(doc, 'firstResponse'),
    ['Min 1d 0h', 'Median 3d 0h', 'Mean 3d 14h', 'Max 8d 0h'],
    'the advisory without a response is unread, so no wait is shown'
  );
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="firstResponse"] .bghsa-stats-meta`),
    '5 of 6',
    'the unread advisory shows only as the gap between the count and the total'
  );
});

test('the first response shows the longest wait of an open advisory without one', async () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const now = clockAt;
  const before = /** @param {number} ms */ (ms) => new Date(now - ms).toISOString();
  const waiting = ghsa('wait');
  const closedId = ghsa('clsd');
  const acceptedId = ghsa('acpt');
  const publishedId = ghsa('publ');
  const unread = ghsa('nrd1');
  const { doc } = await repository({
    owner: 'stats-waiting',
    states: {
      triage: [{ ghsaId: waiting }, { ghsaId: unread }],
      draft: [{ ghsaId: acceptedId }],
      published: [{ ghsaId: publishedId }],
      closed: [{ ghsaId: closedId }],
    },
    reads: [
      // The crawl moves the clock on by seconds, well inside the half hour.
      {
        ghsaId: waiting,
        state: 'Triage',
        reportedAt: before(45 * DAY_MS + 3 * HOUR_MS + 30 * 60 * 1000),
      },
      // Unanswered for longer, but closed.
      { ghsaId: closedId, state: 'Closed', reportedAt: before(90 * DAY_MS) },
      {
        ghsaId: acceptedId,
        state: 'Draft',
        reportedAt: '2026-03-02T00:00:00Z',
        timeline: [{ at: '2026-03-03T00:00:00Z', text: 'samuelkarp accepted this report' }],
      },
      {
        ghsaId: publishedId,
        state: 'Published',
        reportedAt: '2026-03-02T00:00:00Z',
        timeline: [{ at: '2026-03-05T00:00:00Z', text: 'samuelkarp published this' }],
      },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  assert.deepStrictEqual(timingLines(doc, 'firstResponse'), [
    'Min 1d 0h',
    'Median 2d 0h',
    'Mean 2d 0h',
    'Max 3d 0h',
    'No response 45d 3h',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="firstResponse"] .bghsa-stats-meta`),
    '4 of 5'
  );
});

test('the time to accept is over read advisories, and waits on triage', async () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const now = clockAt;
  const before = /** @param {number} ms */ (ms) => new Date(now - ms).toISOString();
  const reported = '2026-03-02T00:00:00Z';
  /**
   * @param {string} day The day of March 2026 the report was accepted.
   * @returns {{ at: string, text: string }}
   */
  const acceptedOn = (day) => ({
    at: `2026-03-${day}T00:00:00Z`,
    text: 'samuelkarp accepted this report',
  });
  const ids = {
    longest: ghsa('acc1'),
    shorter: ghsa('acc2'),
    triageUnread: ghsa('acc3'),
    draft: ghsa('acc4'),
    draftUnaccepted: ghsa('acc5'),
    published: ghsa('acc6'),
    publishedUnaccepted: ghsa('acc7'),
    closed: ghsa('acc8'),
    closedUnaccepted: ghsa('acc9'),
    closedUnread: ghsa('accx'),
  };
  const { doc } = await repository({
    owner: 'stats-accept',
    states: {
      triage: [{ ghsaId: ids.longest }, { ghsaId: ids.shorter }, { ghsaId: ids.triageUnread }],
      draft: [{ ghsaId: ids.draft }, { ghsaId: ids.draftUnaccepted }],
      published: [{ ghsaId: ids.published }, { ghsaId: ids.publishedUnaccepted }],
      closed: [
        { ghsaId: ids.closed },
        { ghsaId: ids.closedUnaccepted },
        { ghsaId: ids.closedUnread },
      ],
    },
    reads: [
      // The crawl moves the clock on by seconds, well inside the half hour.
      {
        ghsaId: ids.longest,
        state: 'Triage',
        reportedAt: before(20 * DAY_MS + 5 * HOUR_MS + 30 * 60 * 1000),
      },
      { ghsaId: ids.shorter, state: 'Triage', reportedAt: before(7 * DAY_MS) },
      { ghsaId: ids.draft, state: 'Draft', reportedAt: reported, timeline: [acceptedOn('03')] },
      // Never accepted and waiting longer than the triage advisories, but not in triage.
      { ghsaId: ids.draftUnaccepted, state: 'Draft', reportedAt: before(90 * DAY_MS) },
      {
        ghsaId: ids.published,
        state: 'Published',
        reportedAt: reported,
        timeline: [acceptedOn('05')],
      },
      { ghsaId: ids.publishedUnaccepted, state: 'Published', reportedAt: before(100 * DAY_MS) },
      { ghsaId: ids.closed, state: 'Closed', reportedAt: reported, timeline: [acceptedOn('08')] },
      { ghsaId: ids.closedUnaccepted, state: 'Closed', reportedAt: before(200 * DAY_MS) },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  // Accepted 1, 3, and 6 days after the report; the mean is 10/3 days.
  assert.deepStrictEqual(timingLines(doc, 'accept'), [
    'Min 1d 0h',
    'Median 3d 0h',
    'Mean 3d 8h',
    'Max 6d 0h',
    'Never accepted 20d 5h',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="accept"] .bghsa-stats-meta`),
    '8 of 10',
    'the two unread advisories show only as the gap between the count and the total'
  );

  const none = await repository({
    owner: 'stats-accept-none',
    states: {
      triage: [{ ghsaId: ghsa('acn1') }],
      draft: [{ ghsaId: ghsa('acn2') }],
      published: [{ ghsaId: ghsa('acn3') }],
      closed: [{ ghsaId: ghsa('acn4') }],
    },
    reads: [
      { ghsaId: ghsa('acn2'), state: 'Draft', reportedAt: before(90 * DAY_MS) },
      {
        ghsaId: ghsa('acn3'),
        state: 'Published',
        reportedAt: reported,
        timeline: [acceptedOn('03')],
      },
      { ghsaId: ghsa('acn4'), state: 'Closed', reportedAt: before(200 * DAY_MS) },
    ],
    crawl: ['open', 'done'],
  });
  statsToggle(none.doc).click();
  await statistics.load(none.doc);
  assert.deepStrictEqual(
    timingLines(none.doc, 'accept'),
    ['Min 1d 0h', 'Median 1d 0h', 'Mean 1d 0h', 'Max 1d 0h'],
    'the only triage advisory is unread, so nothing is shown waiting'
  );

  const reopened = await repository({
    owner: 'stats-accept-reopened',
    states: { triage: [{ ghsaId: ghsa('acr1') }] },
    reads: [
      {
        ghsaId: ghsa('acr1'),
        state: 'Triage',
        reportedAt: reported,
        timeline: [
          acceptedOn('04'),
          { at: '2026-03-06T00:00:00Z', text: 'samuelkarp closed this' },
          { at: '2026-03-07T00:00:00Z', text: 'samuelkarp reopened this' },
        ],
      },
    ],
    crawl: ['open', 'done'],
  });
  statsToggle(reopened.doc).click();
  await statistics.load(reopened.doc);
  assert.deepStrictEqual(
    timingLines(reopened.doc, 'accept'),
    ['Min 2d 0h', 'Median 2d 0h', 'Mean 2d 0h', 'Max 2d 0h'],
    'a triage advisory reopened after its acceptance is not waiting to be accepted'
  );
});

test('the time to close is over closed advisories, with no row beside it', async () => {
  const reported = '2026-03-02T00:00:00Z';
  /**
   * @param {string} who
   * @param {string} day The day of March 2026 the advisory was closed.
   * @returns {{ at: string, text: string }}
   */
  const closedOn = (who, day) => ({ at: `2026-03-${day}T00:00:00Z`, text: `${who} closed this` });
  const ids = {
    byMaintainer: ghsa('cls1'),
    withdrawn: ghsa('cls2'),
    silent: ghsa('cls3'),
    unread: ghsa('cls4'),
    reopened: ghsa('cls5'),
    triageUnread: ghsa('cls6'),
    published: ghsa('cls7'),
    publishedUnread: ghsa('cls8'),
  };
  const { doc } = await repository({
    owner: 'stats-close',
    states: {
      triage: [{ ghsaId: ids.reopened }, { ghsaId: ids.triageUnread }],
      published: [{ ghsaId: ids.published }, { ghsaId: ids.publishedUnread }],
      closed: [
        { ghsaId: ids.byMaintainer },
        { ghsaId: ids.withdrawn },
        { ghsaId: ids.silent },
        { ghsaId: ids.unread },
      ],
    },
    reads: [
      {
        ghsaId: ids.byMaintainer,
        state: 'Closed',
        reportedAt: reported,
        timeline: [closedOn('samuelkarp', '04')],
      },
      // The reporter withdrew it.
      {
        ghsaId: ids.withdrawn,
        state: 'Closed',
        reportedAt: reported,
        timeline: [closedOn('prakleumas', '09')],
      },
      { ghsaId: ids.silent, state: 'Closed', reportedAt: reported },
      // Closed and reopened, so outside the closed advisories.
      {
        ghsaId: ids.reopened,
        state: 'Triage',
        reportedAt: reported,
        timeline: [closedOn('samuelkarp', '03')],
      },
      {
        ghsaId: ids.published,
        state: 'Published',
        reportedAt: reported,
        timeline: [closedOn('samuelkarp', '31')],
      },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  // Closed 2 and 7 days after the report.
  assert.deepStrictEqual(timingLines(doc, 'close'), [
    'Min 2d 0h',
    'Median 4d 12h',
    'Mean 4d 12h',
    'Max 7d 0h',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="close"] .bghsa-stats-meta`),
    '3 of 4',
    'the unread closed advisory shows only as the gap between the count and the total'
  );
});

test('the time to publish is over published advisories, and waits on drafts', async () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const now = clockAt;
  const before = /** @param {number} ms */ (ms) => new Date(now - ms).toISOString();
  const reported = '2026-03-02T00:00:00Z';
  /**
   * @param {string} day The day of March 2026 the advisory was published.
   * @returns {{ at: string, text: string }}
   */
  const publishedOn = (day) => ({
    at: `2026-03-${day}T00:00:00Z`,
    text: 'samuelkarp published this',
  });
  const ids = {
    sooner: ghsa('pub1'),
    later: ghsa('pub2'),
    silent: ghsa('pub3'),
    unread: ghsa('pub4'),
    longest: ghsa('pub5'),
    shorter: ghsa('pub6'),
    draftUnread: ghsa('pub7'),
    triage: ghsa('pub8'),
    closed: ghsa('pub9'),
  };
  const { doc } = await repository({
    owner: 'stats-publish',
    states: {
      triage: [{ ghsaId: ids.triage }],
      draft: [{ ghsaId: ids.longest }, { ghsaId: ids.shorter }, { ghsaId: ids.draftUnread }],
      published: [
        { ghsaId: ids.sooner },
        { ghsaId: ids.later },
        { ghsaId: ids.silent },
        { ghsaId: ids.unread },
      ],
      closed: [{ ghsaId: ids.closed }],
    },
    reads: [
      {
        ghsaId: ids.sooner,
        state: 'Published',
        reportedAt: reported,
        timeline: [publishedOn('06')],
      },
      {
        ghsaId: ids.later,
        state: 'Published',
        reportedAt: reported,
        timeline: [publishedOn('12')],
      },
      { ghsaId: ids.silent, state: 'Published', reportedAt: reported },
      // The crawl moves the clock on by seconds, well inside the half hour.
      {
        ghsaId: ids.longest,
        state: 'Draft',
        reportedAt: before(12 * DAY_MS + 7 * HOUR_MS + 30 * 60 * 1000),
      },
      { ghsaId: ids.shorter, state: 'Draft', reportedAt: before(3 * DAY_MS) },
      // Unpublished and waiting longer than the drafts, but not drafts.
      { ghsaId: ids.triage, state: 'Triage', reportedAt: before(60 * DAY_MS) },
      // The population is by state, so this event is outside it.
      {
        ghsaId: ids.closed,
        state: 'Closed',
        reportedAt: reported,
        timeline: [publishedOn('03')],
      },
    ],
    crawl: ['open', 'done'],
  });

  statsToggle(doc).click();
  await statistics.load(doc);

  // Published 4 and 10 days after the report.
  assert.deepStrictEqual(timingLines(doc, 'publish'), [
    'Min 4d 0h',
    'Median 7d 0h',
    'Mean 7d 0h',
    'Max 10d 0h',
    'Never published 12d 7h',
  ]);
  assert.strictEqual(
    textOf(doc, `#${statistics.ROOT_ID} [data-bghsa-timing="publish"] .bghsa-stats-meta`),
    '3 of 4',
    'the unread published advisory shows only as the gap between the count and the total'
  );

  const none = await repository({
    owner: 'stats-publish-none',
    states: {
      triage: [{ ghsaId: ghsa('pbn1') }],
      draft: [{ ghsaId: ghsa('pbn2') }],
      published: [{ ghsaId: ghsa('pbn3') }],
      closed: [{ ghsaId: ghsa('pbn4') }],
    },
    reads: [
      { ghsaId: ghsa('pbn1'), state: 'Triage', reportedAt: before(60 * DAY_MS) },
      {
        ghsaId: ghsa('pbn3'),
        state: 'Published',
        reportedAt: reported,
        timeline: [publishedOn('04')],
      },
      { ghsaId: ghsa('pbn4'), state: 'Closed', reportedAt: before(80 * DAY_MS) },
    ],
    crawl: ['open', 'done'],
  });
  statsToggle(none.doc).click();
  await statistics.load(none.doc);
  assert.deepStrictEqual(
    timingLines(none.doc, 'publish'),
    ['Min 2d 0h', 'Median 2d 0h', 'Mean 2d 0h', 'Max 2d 0h'],
    'the only draft is unread, so nothing is shown waiting'
  );
});
