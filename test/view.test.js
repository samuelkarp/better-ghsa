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

test.before(async () => {
  allowlist.setStorage({
    get: async () => ({ [allowlist.STORAGE_KEY]: ['git-utensils/spoon-knife'] }),
    set: async () => {},
  });
  await allowlist.load();
});

globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

const TRIAGE_ID = 'GHSA-jmvx-2wfw-xfgj';

test('the storage stand-in holds a copy of what it was seeded with', async () => {
  const held = { advisory: { read: 1 } };
  const store = fakeStorage(held);
  await store.set({ advisory: { read: 2 } });
  assert.deepStrictEqual(held, { advisory: { read: 1 } }, 'a write reached the seed');
  assert.deepStrictEqual((await store.get('advisory'))['advisory'], { read: 2 });
});

const MINUTE = 60 * 1000;

let clockAt = Date.parse('2026-08-27T12:00:00Z');
cache.setClock(() => clockAt);
cache.setStorage(fakeStorage());

/** @type {Record<string, string>} */
const pages = {};

/** @type {string[]} */
const asked = [];

/**
 * Run each path's callback once, when its request is received.
 *
 * @type {Record<string, () => Promise<void>>}
 */
const during = {};

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
 * Staging a closure reason includes asynchronous fingerprint calculations.
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
 * @returns {string[]} The matched texts with whitespace collapsed.
 */
function textsOf(scope, selector) {
  return Array.from(scope.querySelectorAll(selector)).map((node) =>
    (node.textContent ?? '').replace(/\s+/g, ' ').trim()
  );
}

/**
 * linkedom reads a select's value from the selected attribute.
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
 * @returns {string} The chip texts under the title, separated by spaces.
 */
function chipLine(row) {
  return textsOf(row, '.bghsa-done-chips span.Label').join(' ');
}

/**
 * @param {Element} row
 * @returns {string} The state chip text, or an empty string.
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
 * @param {string} prefix The surface class prefix.
 * @returns {string[]} The columns after the title, in display order.
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
 * @returns {Element} The advisory row in the completed list.
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
  // GitHub places pagination beside the Box.
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
 * Timeline text starts with the actor login, followed by the event phrase.
 *
 * @param {{ at: string, text: string }} fields
 * @returns {import('../src/common/parse-detail.js').TimelineEvent}
 */
function event(fields) {
  return {
    id: `event-${fields.at}`,
    actor: 'samuelkarp',
    at: fields.at,
    text: `samuelkarp ${fields.text}`,
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
 * Build the corpus from crawled rows and cached records through membersOf.
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
   * @returns {string} The visible views, joined by "+".
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
   * @returns {void} Clicks a visible control; fails if the control is hidden.
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
      // Use a class inconsistent with the severity to check that the supplied class is preserved.
      member({
        ghsaId: painted,
        state: 'published',
        severity: 'low',
        severityClass: 'Label--orange',
      }),
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
      member({ ghsaId: bare, state: 'published', severity: 'low' }),
      // The advisory was crawled as closed and read as triage.
      // The row follows the advisory read.
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

  for (const name of ['bghsa-tone-done', 'bghsa-tone-success', 'bghsa-fill']) {
    assert.ok(view.STYLE_TEXT.includes(`.${name} {`), `no rule defines .${name}`);
  }
});

test("a completed row carries the line GitHub's own row carried", async () => {
  const closed = ghsa('ceec');
  const doc = await page(
    await corpusOf([member({ ghsaId: closed, state: 'closed', openedAt: '2026-03-14T00:00:00Z' })])
  );

  assert.strictEqual(
    textOf(doneRow(doc, closed), '.bghsa-done-meta'),
    `${closed} opened 2026-03-14 by prakleumas`
  );
});

test('a completed row names the day the advisory ended after that line', async () => {
  const closed = ghsa('cfca');
  const published = ghsa('cfcb');
  const neither = ghsa('cfcc');
  const doc = await page(
    await corpusOf([
      member({
        ghsaId: closed,
        state: 'closed',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: closed,
          state: 'Closed',
          timeline: [event({ at: '2026-08-02T09:00:00Z', text: 'closed this as not planned' })],
        }),
      }),
      member({
        ghsaId: published,
        state: 'published',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: published,
          state: 'Published',
          timeline: [event({ at: '2026-08-02T09:00:00Z', text: 'published this advisory' })],
        }),
      }),
      member({
        ghsaId: neither,
        state: 'closed',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({ ghsaId: neither, state: 'Closed' }),
      }),
    ])
  );

  assert.strictEqual(
    textOf(doneRow(doc, closed), '.bghsa-done-meta'),
    `${closed} opened 2026-03-14 by prakleumas closed 2026-08-02`,
    'a closed row'
  );
  assert.strictEqual(
    textOf(doneRow(doc, published), '.bghsa-done-meta'),
    `${published} opened 2026-03-14 by prakleumas published 2026-08-02`,
    'a published row'
  );
  assert.strictEqual(
    textOf(doneRow(doc, neither), '.bghsa-done-meta'),
    `${neither} opened 2026-03-14 by prakleumas`,
    'a row whose ending nothing named'
  );
});

test('the ending a completed row takes is the one its state names', async () => {
  // The current state selects the ending used for display and sorting.
  // For triage advisories, prior close events are excluded from the current ending.
  const closed = ghsa('eaaa');
  const reopened = ghsa('ebbb');
  const revived = ghsa('eccc');
  const doc = await page(
    await corpusOf([
      member({
        ghsaId: closed,
        state: 'closed',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: closed,
          state: 'Closed',
          timeline: [event({ at: '2026-06-15T09:00:00Z', text: 'closed this as not planned' })],
        }),
      }),
      member({
        ghsaId: reopened,
        state: 'published',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: reopened,
          state: 'Published',
          timeline: [
            event({ at: '2026-05-01T09:00:00Z', text: 'closed this as not planned' }),
            event({ at: '2026-08-02T09:00:00Z', text: 'published this advisory' }),
          ],
        }),
      }),
      member({
        ghsaId: revived,
        state: 'closed',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: revived,
          state: 'Triage',
          timeline: [event({ at: '2026-07-01T09:00:00Z', text: 'closed this as not planned' })],
        }),
      }),
    ])
  );

  assert.strictEqual(
    textOf(doneRow(doc, reopened), '.bghsa-done-meta'),
    `${reopened} opened 2026-03-14 by prakleumas published 2026-08-02`,
    'the publication it ended at, and not the close it came back from'
  );
  assert.strictEqual(
    textOf(doneRow(doc, revived), '.bghsa-done-meta'),
    `${revived} opened 2026-03-14 by prakleumas`,
    'no ending on the row whose state names neither'
  );
  assert.strictEqual(
    shownIds(doc),
    [reopened, closed, revived].join(' '),
    'sorted by that publication, and the row with no ending below both'
  );
});

test('a completed row takes the last of the endings its state names', async () => {
  // Rows use the latest close or publication. Timing metrics use the first.
  // These events produce different row orders for the two choices.
  const reopened = ghsa('gaaa');
  const republished = ghsa('gbbb');
  const once = ghsa('gccc');
  const doc = await page(
    await corpusOf([
      member({
        ghsaId: reopened,
        state: 'closed',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: reopened,
          state: 'Closed',
          timeline: [
            event({ at: '2026-05-01T09:00:00Z', text: 'closed this as not planned' }),
            event({ at: '2026-08-02T09:00:00Z', text: 'closed this as not planned' }),
          ],
        }),
      }),
      member({
        ghsaId: republished,
        state: 'published',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: republished,
          state: 'Published',
          timeline: [
            event({ at: '2026-04-10T09:00:00Z', text: 'published this advisory' }),
            event({ at: '2026-07-20T09:00:00Z', text: 'published this advisory' }),
          ],
        }),
      }),
      member({
        ghsaId: once,
        state: 'closed',
        openedAt: '2026-03-14T00:00:00Z',
        advisory: advisory({
          ghsaId: once,
          state: 'Closed',
          timeline: [event({ at: '2026-06-15T09:00:00Z', text: 'closed this as not planned' })],
        }),
      }),
    ])
  );

  assert.strictEqual(
    textOf(doneRow(doc, reopened), '.bghsa-done-meta'),
    `${reopened} opened 2026-03-14 by prakleumas closed 2026-08-02`,
    'the close it is sitting in, and not the close it came back from'
  );
  assert.strictEqual(
    textOf(doneRow(doc, republished), '.bghsa-done-meta'),
    `${republished} opened 2026-03-14 by prakleumas published 2026-07-20`,
    'the last publication on the timeline'
  );
  assert.strictEqual(
    shownIds(doc),
    [reopened, republished, once].join(' '),
    'ordered by those two endings, and not by the first of each'
  );
});

test('advisories that ended on one day are ordered by the time of day', async () => {
  // Rows sort by the full timestamp. Equal timestamps retain identifier order.
  const morning = ghsa('faaa');
  const evening = ghsa('fbbb');
  const alsoEvening = ghsa('fccc');

  /**
   * @param {string} ghsaId
   * @param {string} at
   * @returns {import('../src/done/corpus.js').CorpusMember}
   */
  const closedAt = (ghsaId, at) =>
    member({
      ghsaId,
      state: 'closed',
      openedAt: '2026-03-14T00:00:00Z',
      advisory: advisory({
        ghsaId,
        state: 'Closed',
        timeline: [event({ at, text: 'closed this as not planned' })],
      }),
    });

  const doc = await page(
    await corpusOf([
      closedAt(morning, '2026-08-02T01:00:00Z'),
      closedAt(evening, '2026-08-02T20:00:00Z'),
      closedAt(alsoEvening, '2026-08-02T20:00:00Z'),
    ])
  );

  assert.strictEqual(
    shownIds(doc),
    [evening, alsoEvening, morning].join(' '),
    'the later instant first, and the close it ties with after it by identifier'
  );
  assert.strictEqual(
    textOf(doneRow(doc, morning), '.bghsa-done-meta'),
    `${morning} opened 2026-03-14 by prakleumas closed 2026-08-02`,
    'the one day all three of them show'
  );
});

test('the completed list is ordered by the instant each advisory ended', async () => {
  const first = ghsa('daaa');
  const second = ghsa('dbbb');
  const third = ghsa('dccc');
  const noEvent = ghsa('dddd');
  const unread = ghsa('deee');

  /**
   * @param {string} ghsaId
   * @param {string} state
   * @param {string} at
   * @param {string} text
   * @returns {import('../src/done/corpus.js').CorpusMember}
   */
  const endedOn = (ghsaId, state, at, text) =>
    member({
      ghsaId,
      state: state.toLowerCase(),
      advisory: advisory({ ghsaId, state, timeline: [event({ at, text })] }),
    });

  const doc = await page(
    await corpusOf([
      endedOn(first, 'Closed', '2026-01-05T09:00:00Z', 'closed this as not planned'),
      endedOn(second, 'Published', '2026-04-09T09:00:00Z', 'published this advisory'),
      endedOn(third, 'Closed', '2026-08-02T09:00:00Z', 'closed this as not planned'),
      member({ ghsaId: noEvent, state: 'closed', advisory: advisory({ ghsaId: noEvent, state: 'Closed' }) }),
      member({ ghsaId: unread, state: 'closed' }),
    ])
  );

  assert.strictEqual(
    shownIds(doc),
    [third, second, first, noEvent, unread].join(' '),
    'the newest ending first, and the rows with none below them by identifier'
  );
});

test('both lists put the state and the observation in their last two cells', async () => {
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
 * @returns {Element} The completed list's filter control for the facet.
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
 * @returns {string} The menu item labels as one line.
 */
function itemsOf(control) {
  return itemNodes(control)
    .map((item) => (item.textContent ?? '').trim())
    .join(' | ');
}

/**
 * @param {Document} doc
 * @param {string} facet
 * @param {string} value The selected value.
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
  // The severity filter applies to published advisories (REQUIREMENTS.md section 10).
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

  // The closure reason filter applies to closed advisories.
  // Unread rows pass every filter until a read supplies their values.
  pick(doc, 'reason', 'Duplicate');
  assert.strictEqual(shownIds(doc), [named, unread].sort().join(' '));

  pick(doc, 'reason', table.NO_VALUE);
  assert.strictEqual(
    shownIds(doc),
    [bare, unread].sort().join(' '),
    'the closed advisories a reason has still to be set on'
  );

  filterIn(doc, 'state').setAttribute('open', '');
  pick(doc, 'state', 'Closed');
  assert.ok(!filterIn(doc, 'state').hasAttribute('open'), 'the menu a value was picked in stayed open');
  assert.strictEqual(
    textOf(filterIn(doc, 'state'), 'summary'),
    'State: Closed',
    'the control reads the value it is holding the list to'
  );
  pick(doc, 'state', '');

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

  // Both lists share a controls root. Updating one list must preserve the other's filters.
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

  // Update menu items while preserving the open control.
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

  // An incomplete corpus can report running after its collection has stopped.
  const doc = await page(corpusOf(members, { complete: false, running: true }));
  assert.deepStrictEqual(textsOf(doc, header), ['Failed to load all advisories']);

  view.setState(doc, { corpus: corpusOf(members, { complete: false, running: false }) });
  view.draw(doc);
  assert.deepStrictEqual(textsOf(doc, header), ['Failed to load all advisories']);

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

  // The queue count becomes available after the crawl.
  // The header then reports pending advisory reads.
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
    await queue.add([...open]);
    await record();
  };
  for (const id of [done[1], ...open]) during[detailUrl(id ?? '')] = record;

  await view.collect(doc, QUEUE_OPTIONS);

  // Both surfaces share the queue count, including reads requested by the open list.
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
  // A render during a frame replacement can stop collection.
  // The header must reflect that stop when the list returns.
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
    one(doc, '#repo-content-turbo-frame').innerHTML = '';
    await table.render(doc);
    table.ensureRefresh(doc, QUEUE_OPTIONS);
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

  const { queue } = table.queueFor(REF, QUEUE_OPTIONS);
  await queue.load();
  await queue.run();
});

test('the header stands from the ask and counts down while the walk waits', async () => {
  // The completed-list crawl waits behind queued open-list reads.
  // Its header must show progress while those reads finish.
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

  const refreshing = queue.run();
  doneToggle(doc).click();
  record('the ask');
  await view.collect(doc, QUEUE_OPTIONS);
  await refreshing;
  record('the end');

  // The header tracks the shared queue before this view has any rows.
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
  // The queue count includes the in-flight request and both waiting advisories.
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

  view.setState(doc, { corpus: corpusOf([]), reading: false });
  view.draw(doc);
  assert.strictEqual(textOf(doc, `#${view.ROOT_ID} .bghsa-done-empty`), 'Not found');
  view.setState(doc, { corpus: null, ref: null });
});

/**
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

  const pull = one(doneRow(doc, pulled), '.bghsa-done-duplicate');
  assert.strictEqual(pull.textContent?.trim(), 'of containerd/containerd#13327');
  assert.strictEqual(
    one(pull, 'a').getAttribute('href'),
    '/containerd/containerd/pull/13327'
  );
});

test('the duplicate pointer stands under the reason control', async () => {
  // Place the duplicate pointer below the control to preserve closure-column alignment.
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
  // Unbroken duplicate text must wrap within the control width.
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
  // Crawled advisories supply observed members and release branches for the editor.
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

  await cache.clear();

  const first = await page();
  const before = asked.length;
  await view.collect(first);
  assert.strictEqual(
    asked.length - before,
    published.length + closed.length + 2,
    'the first visit reads both list pages and every advisory they name'
  );

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

const MOVED = { owner: 'git-utensils', repo: 'Fork-Knife' };

/**
 * Replace the frame for a soft navigation to another repository.
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
  // An advisory can be cached with a null reference.
  // Writing requires the repository and advisory identifier.
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
