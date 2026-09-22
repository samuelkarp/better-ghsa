'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML, DOMParser } = require('linkedom');

const cache = require('../src/common/cache.js');
const parseList = require('../src/common/parse-list.js');
const queues = require('../src/common/fetch.js');
const corpus = require('../src/done/corpus.js');

const { fakeStorage } = require('../test-support/storage.js');

globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
  /** @type {unknown} */ (DOMParser)
);

const REF = { owner: 'containerd', repo: 'containerd' };

/**
 * Waiting advances the fake clock immediately.
 *
 * @param {number} [start]
 */
function fakeClock(start = 1000) {
  let at = start;
  /** @type {number[]} */
  const waits = [];
  return {
    waits,
    now: () => at,
    /** @param {number} ms */
    wait: async (ms) => {
      waits.push(ms);
      at += ms;
    },
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
 * @param {{ state: string, ids: readonly string[], counts?: Record<string, number>, next?: string | null }} page
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
  const next =
    page.next === undefined || page.next === null ? '' : `<a rel="next" href="${page.next}">Next</a>`;
  return (
    `<div id="advisories"><segmented-control><ul>${tabs}</ul></segmented-control>` +
    `<div class="Box">${rows}</div>${next}</div>`
  );
}

/**
 * @param {string} html
 * @returns {import('../src/common/parse-list.js').ParsedList}
 */
function parse(html) {
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const list = parseList.parseList(doc);
  if (list === null) throw new Error('the markup did not read as an advisory list');
  return list;
}

const PUBLISHED_URL = `/${REF.owner}/${REF.repo}/security/advisories?state=published`;
const CLOSED_URL = `/${REF.owner}/${REF.repo}/security/advisories?state=closed`;

/**
 * The description header supplies the report time and reporter.
 *
 * @param {{ ghsaId: string, state: string, severity?: string, reportedAt: string }} advisory
 * @returns {string}
 */
function detailHtml(advisory) {
  const severity =
    advisory.severity === undefined
      ? ''
      : `<span class="Label--large" title="Severity: ${advisory.severity}">${advisory.severity}</span>`;
  return (
    `<div class="gh-header-meta"><span class="State">${advisory.state}</span>${severity}` +
    `<span class="user-select-contain">${advisory.ghsaId}</span></div>` +
    '<div class="js-repository-advisory-details"><div class="Box-header timeline-comment-header">' +
    '<a class="author" href="/prakleumas">prakleumas</a> opened ' +
    `<relative-time datetime="${advisory.reportedAt}"></relative-time></div></div>`
  );
}

/**
 * List and advisory requests share one queue and clock.
 *
 * @param {Record<string, string>} pages By path.
 */
function harness(pages) {
  const clock = fakeClock();
  const storage = fakeStorage();
  /** @type {string[]} */
  const urls = [];
  /** @type {import('../src/common/write.js').WriteFetch} */
  const send = async (url) => {
    urls.push(url);
    const body = pages[url];
    if (body === undefined) return { status: 404, text: async () => '' };
    return { status: 200, text: async () => body };
  };
  const queue = queues.createQueue({
    ref: REF,
    storage,
    now: clock.now,
    wait: clock.wait,
    random: () => 0,
    fetch: send,
  });
  /**
   * @param {Partial<import('../src/done/corpus.js').CorpusOptions>} [extra]
   * @returns {ReturnType<typeof corpus.collect>} The corpus, using the queue clock.
   */
  const collect = (extra = {}) =>
    corpus.collect({ ref: REF, queue, storage, now: clock.now, ...extra });

  return { clock, storage, queue, urls, collect };
}

/**
 * @param {string} ghsaId
 * @returns {string} the path the queue reads that advisory from.
 */
function detailUrl(ghsaId) {
  return `/${REF.owner}/${REF.repo}/security/advisories/${ghsaId}`;
}

test('the corpus walks both done states and reads every advisory it names', async () => {
  const published = [ghsa('aaaa'), ghsa('bbbb')];
  const closed = [ghsa('cccc')];
  const pages = {
    [PUBLISHED_URL]: listHtml({
      state: 'published',
      ids: published,
      counts: { published: 2, closed: 1 },
    }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: closed, counts: { published: 2, closed: 1 } }),
  };
  for (const id of published) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      severity: 'High',
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

  const { storage, urls, collect } = harness(pages);
  const collected = await collect();

  assert.deepStrictEqual(urls, [
    PUBLISHED_URL,
    CLOSED_URL,
    detailUrl(published[0] ?? ''),
    detailUrl(published[1] ?? ''),
    detailUrl(closed[0] ?? ''),
  ]);
  assert.strictEqual(collected.crawled.fetched, 2, 'one page of each state');
  assert.strictEqual(collected.read.fetched, 3, 'one read per advisory');
  assert.deepStrictEqual(
    collected.corpus.members.map((member) => member.ghsaId),
    [...published, ...closed].sort()
  );
  assert.deepStrictEqual(collected.corpus.unread, []);
  assert.strictEqual(collected.corpus.complete, true);
  assert.strictEqual(collected.corpus.members[0]?.advisory?.state, 'Published');
  assert.strictEqual(
    collected.corpus.members.find((member) => member.ghsaId === closed[0])?.advisory?.state,
    'Closed'
  );

  const entry = await cache.getAdvisory({ ...REF, ghsaId: closed[0] }, { storage, at: 1 });
  assert.strictEqual(entry?.state, 'closed', 'a closed entry lives by the closed life');
});

test('the corpus spends one request a second across the walk and the reads', async () => {
  const ids = [ghsa('aaaa'), ghsa('bbbb')];
  const pages = {
    [PUBLISHED_URL]: listHtml({ state: 'published', ids, counts: { published: 2 } }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { published: 2 } }),
  };
  for (const id of ids) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }
  const { clock, collect } = harness(pages);
  await collect();
  // Four requests require three one-second intervals.
  assert.deepStrictEqual(clock.waits, [queues.RATE_MS, queues.RATE_MS, queues.RATE_MS]);
});

test('an advisory the corpus holds no read of is a member and is named unread', async () => {
  const ids = [ghsa('aaaa'), ghsa('bbbb')];
  const pages = {
    [PUBLISHED_URL]: listHtml({ state: 'published', ids, counts: { published: 2 } }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { published: 2 } }),
    [detailUrl(ids[0] ?? '')]: detailHtml({
      ghsaId: ids[0] ?? '',
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    }),
  };
  const { collect } = harness(pages);
  const collected = await collect();

  assert.deepStrictEqual(
    collected.corpus.members.map((member) => member.ghsaId),
    ids
  );
  assert.deepStrictEqual(collected.corpus.unread, [ids[1]]);
  const unread = collected.corpus.members[1];
  assert.strictEqual(unread?.advisory, null, 'no read backs it');
  assert.strictEqual(unread?.observedAt, null, 'and nothing was observed of it');
  assert.strictEqual(unread?.row.severity, 'high', 'what the list page said stands');
  assert.strictEqual(unread?.state, 'published');
});

test("the corpus carries GitHub's own count of each done state", async () => {
  const pages = {
    [PUBLISHED_URL]: listHtml({
      state: 'published',
      ids: [ghsa('aaaa')],
      counts: { triage: 3, published: 41, closed: 12 },
    }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { published: 41, closed: 12 } }),
  };
  pages[detailUrl(ghsa('aaaa'))] = detailHtml({
    ghsaId: ghsa('aaaa'),
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  const { collect } = harness(pages);
  const parsed = parse(/** @type {string} */ (pages[PUBLISHED_URL]));
  const collected = await collect({ parsed, href: PUBLISHED_URL });
  assert.deepStrictEqual(collected.corpus.expected, { published: 41, closed: 12 });
});

test('a corpus collected off the list page counts nothing it did not see', async () => {
  const pages = {
    [PUBLISHED_URL]: listHtml({ state: 'published', ids: [], counts: { published: 0 } }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { closed: 0 } }),
  };
  const { collect } = harness(pages);
  const collected = await collect();
  assert.deepStrictEqual(collected.corpus.expected, { published: null, closed: null });
});

test('the open advisories on the list are no part of the done corpus', async () => {
  const done = ghsa('aaaa');
  const open = ghsa('bbbb');
  const pages = {
    [PUBLISHED_URL]: listHtml({ state: 'published', ids: [done], counts: { published: 1 } }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { published: 1 } }),
  };
  pages[detailUrl(done)] = detailHtml({
    ghsaId: done,
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  const { storage, collect } = harness(pages);
  await globalThis.bghsa.crawl.crawl({
    ref: REF,
    queue: {
      page: async () => ({
        body: listHtml({ state: 'triage', ids: [open] }),
        status: 200,
        reason: null,
        stopped: false,
      }),
    },
    storage,
    states: ['triage'],
    parse: (html) => parse(html),
  });

  const collected = await collect();
  assert.deepStrictEqual(
    collected.corpus.members.map((member) => member.ghsaId),
    [done]
  );
});

test('a walk that did not reach its last page says the corpus is partial', async () => {
  const first = ghsa('aaaa');
  const second = ghsa('bbbb');
  const secondPage = `${PUBLISHED_URL}&page=2`;
  const pages = {
    [PUBLISHED_URL]: listHtml({
      state: 'published',
      ids: [first],
      counts: { published: 2 },
      next: secondPage,
    }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { published: 2 } }),
  };
  pages[detailUrl(first)] = detailHtml({
    ghsaId: first,
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  const { collect } = harness(pages);
  const collected = await collect();
  assert.strictEqual(collected.corpus.complete, false);
  assert.deepStrictEqual(
    collected.corpus.members.map((member) => member.ghsaId),
    [first]
  );
  assert.ok(!collected.corpus.members.some((member) => member.ghsaId === second));
});

test('a corpus drawn inside the walk says a collection is filling it', async () => {
  const ids = [ghsa('aaaa')];
  const pages = {
    [PUBLISHED_URL]: listHtml({ state: 'published', ids, counts: { published: 1 } }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { published: 1 } }),
  };
  pages[detailUrl(ids[0] ?? '')] = detailHtml({
    ghsaId: ids[0] ?? '',
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  const { collect } = harness(pages);
  /** @type {boolean[]} */
  const running = [];
  const collected = await collect({
    onPage: (held) => {
      running.push(held.running);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(running.length > 0, 'the walk drew the corpus at least once');
  assert.ok(
    running.every((flag) => flag === true),
    `a corpus drawn inside the walk said nothing was filling it: ${JSON.stringify(running)}`
  );
  assert.strictEqual(
    collected.corpus.running,
    false,
    'the corpus the collection ended on says one is still filling it'
  );
  assert.strictEqual(collected.corpus.complete, true);
});

test('a page of the walk draws the corpus before any advisory is read', async () => {
  const ids = [ghsa('aaaa')];
  const pages = {
    [PUBLISHED_URL]: listHtml({ state: 'published', ids, counts: { published: 1 } }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: [], counts: { published: 1 } }),
  };
  pages[detailUrl(ids[0] ?? '')] = detailHtml({
    ghsaId: ids[0] ?? '',
    state: 'Published',
    reportedAt: '2026-03-02T00:00:00Z',
  });
  const { collect } = harness(pages);
  /** @type {number[]} */
  const drawn = [];
  await collect({
    onPage: (held) => {
      drawn.push(held.members.length);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(drawn.length > 0, 'the walk drew the corpus at least once');
  assert.ok(
    drawn.includes(1),
    `a page that landed named the advisory it carries: ${JSON.stringify(drawn)}`
  );
});

test('the corpus is ordered by identifier, whatever order the crawl found it in', async () => {
  // GitHub page order puts these advisory IDs in reverse order.
  const published = [ghsa('dddd'), ghsa('bbbb')];
  const closed = [ghsa('cccc'), ghsa('aaaa')];
  const found = [...published, ...closed];
  const wanted = [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc'), ghsa('dddd')];
  assert.notDeepStrictEqual(found, wanted, 'the crawl order tells the two orders apart');

  const pages = {
    [PUBLISHED_URL]: listHtml({
      state: 'published',
      ids: published,
      counts: { published: 2, closed: 2 },
    }),
    [CLOSED_URL]: listHtml({ state: 'closed', ids: closed, counts: { published: 2, closed: 2 } }),
  };
  for (const id of found) {
    pages[detailUrl(id)] = detailHtml({
      ghsaId: id,
      state: 'Published',
      reportedAt: '2026-03-02T00:00:00Z',
    });
  }

  const { clock, storage, collect } = harness(pages);
  const collected = await collect();
  assert.deepStrictEqual(
    collected.crawled.ids,
    found,
    'the walk holds them in the order it met them'
  );
  assert.deepStrictEqual(
    collected.corpus.members.map((member) => member.ghsaId),
    wanted,
    'the members are ordered by identifier'
  );

  /** @type {import('../src/common/crawl.js').CrawledList} */
  const other = { walks: {}, rows: {} };
  for (const id of Object.keys(collected.crawled.list.rows).reverse()) {
    other.rows[id] = /** @type {import('../src/common/crawl.js').CrawledList['rows'][string]} */ (
      collected.crawled.list.rows[id]
    );
  }
  const again = await corpus.membersOf(REF, other, { storage, at: clock.now(), complete: true });
  assert.deepStrictEqual(
    again.members.map((member) => member.ghsaId),
    collected.corpus.members.map((member) => member.ghsaId),
    'two collections of one corpus order it the same way'
  );
});
