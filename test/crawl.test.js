'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHTML } = require('linkedom');

const cache = require('../src/common/cache.js');
const parseList = require('../src/common/parse-list.js');
const crawls = require('../src/common/crawl.js');

const { fakeStorage } = require('../test-support/storage.js');

const REF = { owner: 'git-utensils', repo: 'Spoon-Knife' };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/**
 * @param {string} suffix
 * @returns {string}
 */
function ghsa(suffix) {
  return `GHSA-${suffix}-${suffix}-${suffix}`;
}

/**
 * @param {{ state: string, ids: readonly string[], next?: string | null }} page
 * @returns {string}
 */
function listHtml(page) {
  const label = /** @type {string} */ (parseList.STATES[page.state]);
  const base = `/${REF.owner}/${REF.repo}/security/advisories`;
  const tabs = Object.entries(parseList.STATES)
    .map(
      ([state, name]) =>
        `<li class="SegmentedControl-item${
          state === page.state ? ' SegmentedControl-item--selected' : ''
        }"><a href="${base}?state=${state}"${
          state === page.state ? ' aria-current="true"' : ''
        }>2 ${name}</a></li>`
    )
    .join('');
  const rows = page.ids
    .map(
      (id) =>
        `<div class="Box-row Box-row--drag-hide">` +
        `<a class="Link--primary" href="${base}/${id}">Title ${id}</a>` +
        `<span class="tooltipped" aria-label="${label} advisory"></span>` +
        `<span class="opened-by">opened <relative-time datetime="2026-08-01T00:00:00Z">` +
        `</relative-time> by <a class="author" href="/prakleumas">prakleumas</a></span>` +
        `</div>`
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
 * @returns {import('../src/common/parse-list.js').ParsedList} what that markup
 *   says.
 */
function parse(html) {
  const doc = /** @type {Document} */ (/** @type {unknown} */ (parseHTML(html).document));
  const list = parseList.parseList(doc);
  if (list === null) throw new Error('the markup did not read as an advisory list');
  return list;
}

/**
 * Return supplied pages immediately and record requests.
 *
 * @param {Record<string, string>} pages
 */
function fakeQueue(pages) {
  /** @type {string[]} */
  const urls = [];
  return {
    urls,
    /** @param {string} url */
    page: async (url) => {
      urls.push(url);
      const body = pages[url];
      if (body === undefined) {
        return { body: null, status: 404, reason: 'GitHub answered 404.', stopped: false };
      }
      return { body, status: 200, reason: null, stopped: false };
    },
  };
}

/**
 * Return supplied pages and report other requests as stopped.
 *
 * @param {Record<string, string>} pages
 */
function stoppedQueue(pages) {
  /** @type {string[]} */
  const urls = [];
  return {
    urls,
    /** @param {string} url */
    page: async (url) => {
      urls.push(url);
      const body = pages[url];
      if (body === undefined) {
        return { body: null, status: null, reason: 'The queue was stopped.', stopped: true };
      }
      return { body, status: 200, reason: null, stopped: false };
    },
  };
}

/**
 * @param {Partial<import('../src/common/crawl.js').CrawlOptions>} extra
 * @returns {import('../src/common/crawl.js').CrawlOptions}
 */
function options(extra) {
  return {
    ref: REF,
    queue: extra.queue ?? fakeQueue({}),
    parse: (html) => parse(html),
    ...extra,
  };
}

const TRIAGE_URL = `/${REF.owner}/${REF.repo}/security/advisories?state=triage`;
const DRAFT_URL = `/${REF.owner}/${REF.repo}/security/advisories?state=draft`;

test('a walk follows rel="next" through every page of a state', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa'), ghsa('bbbb')],
      next: `${TRIAGE_URL}&page=2`,
    }),
    [`${TRIAGE_URL}&page=2`]: listHtml({ state: 'triage', ids: [ghsa('cccc')] }),
  });

  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL, `${TRIAGE_URL}&page=2`]);
  assert.deepStrictEqual(result.ids.sort(), [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')].sort());
  assert.ok(result.complete, 'the walk did not finish');
  assert.ok(result.fetched === 2, `${result.fetched} pages were read`);
});

test('both open states are crawled whichever tab the page was opened on', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
    [DRAFT_URL]: listHtml({ state: 'draft', ids: [ghsa('bbbb')] }),
  });

  const result = await crawls.crawl(options({ queue, storage, now: () => 0 }));

  assert.deepStrictEqual(queue.urls.sort(), [DRAFT_URL, TRIAGE_URL].sort());
  assert.deepStrictEqual(result.ids.sort(), [ghsa('aaaa'), ghsa('bbbb')].sort());
});

test('the page being looked at costs no request', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [`${TRIAGE_URL}&page=2`]: listHtml({ state: 'triage', ids: [ghsa('cccc')] }),
    [DRAFT_URL]: listHtml({ state: 'draft', ids: [ghsa('dddd')] }),
  });
  const parsed = parse(
    listHtml({
      state: 'triage',
      ids: [ghsa('aaaa'), ghsa('bbbb')],
      next: `${TRIAGE_URL}&page=2`,
    })
  );

  const result = await crawls.crawl(
    options({
      queue,
      storage,
      now: () => 0,
      parsed,
      href: `https://github.com${TRIAGE_URL}`,
    })
  );

  assert.deepStrictEqual(queue.urls.sort(), [`${TRIAGE_URL}&page=2`, DRAFT_URL].sort());
  assert.deepStrictEqual(
    result.ids.sort(),
    [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc'), ghsa('dddd')].sort()
  );
});

test('a page other than the first does not start the walk', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
  });
  const parsed = parse(listHtml({ state: 'triage', ids: [ghsa('bbbb')] }));

  await crawls.crawl(
    options({
      queue,
      storage,
      now: () => 0,
      states: ['triage'],
      parsed,
      href: `${TRIAGE_URL}&page=3`,
    })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL]);
});

test('landing on page one keeps a walk that is part way through', async () => {
  const storage = fakeStorage();
  const second = `${TRIAGE_URL}&page=2`;
  const third = `${TRIAGE_URL}&page=3`;
  const one = listHtml({ state: 'triage', ids: [ghsa('aaaa')], next: second });
  const two = listHtml({ state: 'triage', ids: [ghsa('bbbb')], next: third });
  const three = listHtml({ state: 'triage', ids: [ghsa('cccc')] });

  const before = fakeQueue({ [TRIAGE_URL]: one, [second]: two });
  await crawls.crawl(options({ queue: before, storage, now: () => 0, states: ['triage'] }));
  assert.deepStrictEqual(before.urls, [TRIAGE_URL, second, third]);

  const after = fakeQueue({ [TRIAGE_URL]: one, [second]: two, [third]: three });
  const resumed = await crawls.crawl(
    options({
      queue: after,
      storage,
      now: () => MINUTE,
      states: ['triage'],
      parsed: parse(one),
      href: TRIAGE_URL,
    })
  );

  assert.deepStrictEqual(after.urls, [third], 'the walk was started over from page one');
  assert.deepStrictEqual(
    resumed.ids.sort(),
    [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')].sort(),
    'the resumed walk lost an advisory'
  );
  assert.ok(resumed.complete, 'the resumed walk did not finish');
});

test('a crawl a navigation interrupted resumes and repeats no page', async () => {
  const storage = fakeStorage();
  const pages = {
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa')],
      next: `${TRIAGE_URL}&page=2`,
    }),
    [`${TRIAGE_URL}&page=2`]: listHtml({
      state: 'triage',
      ids: [ghsa('bbbb')],
      next: `${TRIAGE_URL}&page=3`,
    }),
    [`${TRIAGE_URL}&page=3`]: listHtml({ state: 'triage', ids: [ghsa('cccc')] }),
  };

  const first = fakeQueue({ [TRIAGE_URL]: /** @type {string} */ (pages[TRIAGE_URL]) });
  const interrupted = await crawls.crawl(
    options({ queue: first, storage, now: () => 0, states: ['triage'] })
  );
  assert.deepStrictEqual(first.urls, [TRIAGE_URL, `${TRIAGE_URL}&page=2`]);
  assert.ok(!interrupted.complete, 'an interrupted walk reported itself finished');

  const second = fakeQueue(pages);
  const resumed = await crawls.crawl(
    options({ queue: second, storage, now: () => MINUTE, states: ['triage'] })
  );

  assert.deepStrictEqual(second.urls, [`${TRIAGE_URL}&page=2`, `${TRIAGE_URL}&page=3`]);
  assert.deepStrictEqual(resumed.ids.sort(), [ghsa('aaaa'), ghsa('bbbb'), ghsa('cccc')].sort());
  assert.ok(resumed.complete, 'the resumed walk did not finish');
});

test('a crawl that finished four minutes ago walks nothing', async () => {
  const storage = fakeStorage();
  const pages = {
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
    [DRAFT_URL]: listHtml({ state: 'draft', ids: [ghsa('bbbb')] }),
  };
  const first = fakeQueue(pages);
  await crawls.crawl(options({ queue: first, storage, now: () => 0 }));
  assert.ok(first.urls.length === 2, `${first.urls.length} pages were read`);

  const soon = fakeQueue(pages);
  const held = await crawls.crawl(options({ queue: soon, storage, now: () => 4 * MINUTE }));
  assert.deepStrictEqual(soon.urls, [], 'a crawl inside the staleness threshold spent requests');
  assert.deepStrictEqual(held.ids.sort(), [ghsa('aaaa'), ghsa('bbbb')].sort());

  const later = fakeQueue(pages);
  await crawls.crawl(options({ queue: later, storage, now: () => 6 * MINUTE }));
  assert.ok(later.urls.length === 2, `${later.urls.length} pages were read after the threshold`);
});

test('an advisory that left a state is dropped when that state is walked again', async () => {
  const storage = fakeStorage();
  const first = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa'), ghsa('bbbb')] }),
  });
  const before = await crawls.crawl(
    options({ queue: first, storage, now: () => 0, states: ['triage'] })
  );
  assert.deepStrictEqual(before.ids.sort(), [ghsa('aaaa'), ghsa('bbbb')].sort());

  const second = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
  });
  const after = await crawls.crawl(
    options({ queue: second, storage, now: () => 6 * MINUTE, states: ['triage'] })
  );
  assert.deepStrictEqual(after.ids, [ghsa('aaaa')]);
});

test('a walk stopped part way keeps the advisories it has not seen again', async () => {
  const storage = fakeStorage();
  const pages = {
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa')],
      next: `${TRIAGE_URL}&page=2`,
    }),
  };
  await crawls.crawl(
    options({ queue: fakeQueue(pages), storage, now: () => 0, states: ['triage'] })
  );

  const again = await crawls.crawl(
    options({ queue: fakeQueue(pages), storage, now: () => MINUTE, states: ['triage'] })
  );
  assert.deepStrictEqual(again.ids, [ghsa('aaaa')]);
});

test('a walk that cannot get past a page gives up and starts over', async () => {
  const storage = fakeStorage();
  const second = `${TRIAGE_URL}&page=2`;
  const wedged = listHtml({ state: 'triage', ids: [ghsa('aaaa'), ghsa('bbbb')], next: second });

  /** @type {string[][]} */
  const attempts = [];
  for (const at of [0, MINUTE, 2 * MINUTE]) {
    const queue = fakeQueue({ [TRIAGE_URL]: wedged });
    const result = await crawls.crawl(
      options({ queue, storage, now: () => at, states: ['triage'] })
    );
    attempts.push(queue.urls);
    assert.ok(!result.complete, `the walk at ${at} reported itself finished`);
  }
  assert.deepStrictEqual(attempts, [[TRIAGE_URL, second], [second], [second]]);

  const quiet = fakeQueue({ [TRIAGE_URL]: wedged });
  await crawls.crawl(options({ queue: quiet, storage, now: () => 3 * MINUTE, states: ['triage'] }));
  assert.deepStrictEqual(quiet.urls, [], 'a walk that gave up spent a request straight away');

  const shrunk = listHtml({ state: 'triage', ids: [ghsa('aaaa')] });
  const again = fakeQueue({ [TRIAGE_URL]: shrunk });
  const done = await crawls.crawl(
    options({ queue: again, storage, now: () => 8 * MINUTE, states: ['triage'] })
  );

  assert.deepStrictEqual(again.urls, [TRIAGE_URL], 'the walk did not start over');
  assert.ok(done.complete, 'the walk that started over did not finish');
  assert.deepStrictEqual(done.ids, [ghsa('aaaa')], 'an advisory that left the state was kept');
});

test('a walk a stop interrupts keeps the page it had reached', async () => {
  const storage = fakeStorage();
  const second = `${TRIAGE_URL}&page=2`;
  const first = listHtml({ state: 'triage', ids: [ghsa('aaaa'), ghsa('bbbb')], next: second });

  const opened = stoppedQueue({ [TRIAGE_URL]: first });
  await crawls.crawl(options({ queue: opened, storage, now: () => 0, states: ['triage'] }));
  assert.deepStrictEqual(opened.urls, [TRIAGE_URL, second]);

  // Stopping before a request is sent does not count as a failed attempt.
  /** @type {string[][]} */
  const attempts = [];
  for (const at of [MINUTE, 2 * MINUTE]) {
    const queue = stoppedQueue({});
    const result = await crawls.crawl(
      options({ queue, storage, now: () => at, states: ['triage'] })
    );
    attempts.push(queue.urls);
    const walk = crawls.walkOf(result.list, 'triage');
    assert.ok(!walk.stalled, `the walk gave up after a stop at ${at}`);
    assert.ok(walk.failures === 0, `a stop at ${at} counted ${walk.failures} failures`);
    assert.ok(walk.next === second, `the walk at ${at} was holding ${walk.next}`);
  }
  assert.deepStrictEqual(attempts, [[second], [second]]);

  const resumed = stoppedQueue({ [second]: listHtml({ state: 'triage', ids: [ghsa('bbbb')] }) });
  const done = await crawls.crawl(
    options({ queue: resumed, storage, now: () => 3 * MINUTE, states: ['triage'] })
  );

  assert.deepStrictEqual(resumed.urls, [second], 'the resumed walk did not ask for its own page');
  assert.ok(done.complete, 'the resumed walk did not finish');
  assert.deepStrictEqual(done.ids.sort(), [ghsa('aaaa'), ghsa('bbbb')].sort());
});

test('a next link that leaves this repository is not followed', async () => {
  const storage = fakeStorage();
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({
      state: 'triage',
      ids: [ghsa('aaaa')],
      next: 'https://example.invalid/anything',
    }),
  });
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL]);
  assert.ok(result.complete, 'the walk did not treat an unusable next link as the last page');

  assert.ok(crawls.advisoriesPath('/other/repo/security/advisories?state=triage', REF) === null);
  assert.ok(crawls.advisoriesPath('//evil.example/x', REF) === null);
  assert.ok(
    crawls.advisoriesPath(`https://github.com${TRIAGE_URL}`, REF) === TRIAGE_URL,
    'a next link GitHub wrote in full was refused'
  );
});

test('a walk gives up rather than following a cycle', async () => {
  const storage = fakeStorage();
  // Each page links to itself.
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')], next: TRIAGE_URL }),
  });
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL], 'the page was read more than once');
  assert.deepStrictEqual(result.ids, [ghsa('aaaa')]);
  assert.ok(!result.complete, 'a walk that stopped on a cycle reported itself complete');
});

/**
 * Build `count` linked pages. The last page ends the list.
 *
 * @param {number} count
 * @returns {Record<string, string>}
 */
function pagedTriage(count) {
  /** @type {Record<string, string>} */
  const pages = {};
  for (let page = 1; page <= count; page += 1) {
    const url = page === 1 ? TRIAGE_URL : `${TRIAGE_URL}&page=${page}`;
    pages[url] = listHtml({
      state: 'triage',
      ids: [ghsa(String(page).padStart(4, '0'))],
      next: page === count ? null : `${TRIAGE_URL}&page=${page + 1}`,
    });
  }
  return pages;
}

test('a walk reads every page of a state, however many there are', async () => {
  const storage = fakeStorage();
  const pages = pagedTriage(60);
  const queue = fakeQueue(pages);
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.strictEqual(queue.urls.length, 60, `${queue.urls.length} pages were read`);
  assert.strictEqual(result.fetched, 60);
  assert.ok(result.complete, 'the walk did not reach the last page');
  assert.ok(
    result.ids.includes(ghsa('0060')),
    'the advisory on the last page is not in the crawl'
  );
});

test('a walk that stops with a page still to read is not recorded complete', async () => {
  const storage = fakeStorage();
  const pages = pagedTriage(60);
  const held = Object.fromEntries(
    Object.entries(pages).filter(([url]) => {
      const page = Number(url.split('page=')[1] ?? '1');
      return page <= 52;
    })
  );
  const queue = stoppedQueue(held);
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.strictEqual(result.fetched, 52, `${result.fetched} pages were read`);
  assert.ok(!result.complete, 'a walk that stopped short reported itself complete');
  const walk = crawls.walkOf(result.list, 'triage');
  assert.ok(!walk.complete, 'the stored walk reported itself complete');
  assert.strictEqual(walk.next, `${TRIAGE_URL}&page=53`, `the walk was holding ${walk.next}`);
});

test('a crawl record of another shape crawls from the start', async () => {
  const storage = fakeStorage();
  await cache.putList(REF, { walks: 'everything', rows: 7 }, { storage, at: 0 });
  const queue = fakeQueue({
    [TRIAGE_URL]: listHtml({ state: 'triage', ids: [ghsa('aaaa')] }),
  });
  const result = await crawls.crawl(
    options({ queue, storage, now: () => 0, states: ['triage'] })
  );

  assert.deepStrictEqual(queue.urls, [TRIAGE_URL]);
  assert.deepStrictEqual(result.ids, [ghsa('aaaa')]);
  assert.deepStrictEqual(crawls.listFrom(null), { walks: {}, rows: {} });
  assert.deepStrictEqual(crawls.listFrom(12), { walks: {}, rows: {} });
});

test("a walk of a done state waits out that state's threshold", () => {
  /**
   * @param {string} state
   * @param {number} completedAt
   * @returns {import('../src/common/crawl.js').CrawledList}
   */
  const walked = (state, completedAt) => ({
    rows: {},
    walks: {
      [state]: {
        next: null,
        started: true,
        complete: true,
        startedAt: 0,
        completedAt,
        pages: 1,
        failures: 0,
        stalled: false,
        abandonedAt: 0,
      },
    },
  });

  assert.ok(!crawls.isDue(walked('published', 0), 'published', 60 * MINUTE), 'an hour on');
  assert.ok(!crawls.isDue(walked('published', 0), 'published', 30 * DAY - 1), 'a millisecond short');
  assert.ok(crawls.isDue(walked('published', 0), 'published', 30 * DAY), 'at thirty days');
  assert.ok(!crawls.isDue(walked('closed', 0), 'closed', 60 * MINUTE), 'closed an hour on');
  assert.ok(crawls.isDue(walked('closed', 0), 'closed', 7 * DAY), 'closed at seven days');
  assert.ok(crawls.isDue(walked('triage', 0), 'triage', 5 * MINUTE), 'triage at five minutes');
});

